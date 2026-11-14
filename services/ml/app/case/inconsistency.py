"""Inconsistency detection (spec N7, X1–X5): rules over metadata, duplicates, amounts,
senders, sequence and the complainant's statement vs documentary evidence.

Each item quotes the ORIGINAL text of both sides. `key` is stable across rebuilds so a
dismissal or explanation note survives reprocessing.
"""
from __future__ import annotations

from collections import defaultdict
from itertools import product

from .common import fmt_money, parse_ts, quote, stable_key

FLAG_SEVERITY = {"EDITED_FILE": 2, "METADATA_MISMATCH": 2, "IMPOSSIBLE_SEQUENCE": 2, "SENDER_MISMATCH": 2}
FIN_IDS = ("UPI_ID", "BANK_ACCT", "PHONE")


def _ref(c: dict) -> dict:
    return {"evidenceId": c["evidenceId"], "chunkId": c["id"], "quote": quote(c.get("text", ""), 200),
            "quoteEn": quote(c["textEn"], 200) if c.get("textEn") and c.get("textEn") != c.get("text") else None}


def detect(evidence: list[dict], chunks: list[dict], dedup: dict, resolved: dict, events: list[dict]) -> list[dict]:
    by_id = {c["id"]: c for c in chunks}
    ev_by_id = {e["id"]: e for e in evidence}
    out: list[dict] = []

    def add(t: str, sev: int, title: str, explanation: str, refs: list[dict], confidence: float, **extra) -> None:
        key = stable_key(t, *sorted(f"{r['evidenceId']}/{r.get('chunkId') or r.get('field', '')}" for r in refs))
        if any(o["key"] == key for o in out):
            return
        out.append({"key": key, "type": t, "severity": sev, "title": title, "explanation": explanation, "refs": refs,
                    "confidence": confidence, **extra})

    # X1: metadata flags from extraction
    for e in evidence:
        name = e.get("sourceLabel") or e["filename"]
        for f in e.get("flags", []):
            t = f["type"]
            if t not in FLAG_SEVERITY:
                continue
            ref = {"evidenceId": e["id"], "field": f.get("field"), "quote": str(f.get("value"))}
            if t == "IMPOSSIBLE_SEQUENCE" and f.get("messageIdx") is not None:
                c = next((c for c in chunks if c["evidenceId"] == e["id"] and c["locator"].get("messageIdx") == f["messageIdx"]), None)
                if c:
                    ref = {**_ref(c), "field": "messageOrder"}
            titles = {
                "EDITED_FILE": f"{name} was processed by editing software",
                "METADATA_MISMATCH": f"{name}: metadata dates disagree",
                "IMPOSSIBLE_SEQUENCE": f"{name}: messages are out of time order",
                "SENDER_MISMATCH": f"{name}: sender headers disagree",
            }
            add(t, FLAG_SEVERITY[t], titles[t], f"{f.get('field')}: {f.get('value')}.", [ref], 0.9)

    # Cross-modal contradictions (same message seen twice with different content/date)
    for p in dedup.get("contradictions", []):
        v, o = by_id.get(p["visualChunkId"]), by_id.get(p["otherChunkId"])
        if not v or not o:
            continue
        if p["kind"] == "content":
            av, ao = _amounts(v), _amounts(o)
            if av and ao and av != ao:
                add("AMOUNT_MISMATCH", 3, f"Amount differs: {fmt_money(max(av))} vs {fmt_money(max(ao))}",
                    f"The same message shows {fmt_money(max(av))} in {_ev_name(ev_by_id, v)} but {fmt_money(max(ao))} in {_ev_name(ev_by_id, o)}.",
                    [_ref(v), _ref(o)], 0.85)
            elif p.get("numbersDiffer") or p["edit"] < 0.85:
                add("CONTENT_CONTRADICTION", 2, "Screenshot text differs from the chat export",
                    f"{_ev_name(ev_by_id, v)} and {_ev_name(ev_by_id, o)} show nearly the same message with different wording or numbers.",
                    [_ref(v), _ref(o)], round(p["semantic"], 2))
        elif p["kind"] == "date":
            add("DATE_CONFLICT", 2, "Same message, different dates",
                f"{_ev_name(ev_by_id, v)} dates this message {v.get('refTs', '?')[:10]}, {_ev_name(ev_by_id, o)} dates it {o.get('refTs', '?')[:10]}.",
                [_ref(v), _ref(o)], 0.8)

    # SENDER_MISMATCH across cross-modal duplicates
    alias = resolved["aliasToEntity"]
    from .events import _alias_key

    for g in dedup.get("groups", []):
        if g["kind"] != "cross_modal":
            continue
        a, b = (by_id.get(m.get("chunkId")) for m in g["members"])
        if not a or not b or not a.get("sender") or not b.get("sender"):
            continue
        sa, sb = alias.get(_alias_key(a["sender"], resolved)), alias.get(_alias_key(b["sender"], resolved))
        if sa and sb and sa != sb:
            add("SENDER_MISMATCH", 3, "Same message attributed to different senders",
                f"{_ev_name(ev_by_id, a)} shows it from {a['sender']}, {_ev_name(ev_by_id, b)} from {b['sender']}.", [_ref(a), _ref(b)], 0.8)

    # AMOUNT_MISMATCH: chat amount vs document amount for the same identifier within ±3 days.
    ident_chunks: dict[str, list[dict]] = defaultdict(list)
    for c in chunks:
        for m in resolved["mentions"].get(c["id"], []):
            if m["type"] in FIN_IDS:
                ident_chunks[m["entityKey"]].append(c)
    # Chunks that are the same message seen twice (chat + screenshot) count once.
    same_as: dict[str, str] = {}
    for g in dedup.get("groups", []):
        if g["kind"] == "cross_modal":
            a, b = (m.get("chunkId") for m in g["members"])
            if a and b:
                same_as[b] = a
    seen_amount: dict[tuple, dict] = {}
    # Also attach amounts in the neighbouring messages (a request often spans two messages).
    for ik, cs in ident_chunks.items():
        chats = [c for c in cs if c.get("unit") in ("message", "bubble", "segment")]
        docs = [c for c in cs if c.get("unit") in ("paragraph", "header", "ocr_block")]
        for a, b in product(chats, docs):
            if a["evidenceId"] == b["evidenceId"]:
                continue
            aa, ab = _amounts(a) or _neighbour_amounts(a, chunks), _amounts(b)
            if not aa or not ab or aa & ab:
                continue
            ta, tb = parse_ts(a.get("refTs")), parse_ts(_doc_time(b))
            if ta and tb and abs((ta - tb).total_seconds()) > 3 * 86400:
                continue
            sig = (ik, max(aa), max(ab), b["id"])
            if sig in seen_amount:
                item = seen_amount[sig]
                if same_as.get(a["id"]) in {r.get("chunkId") for r in item["refs"]} or a["id"] in same_as.values():
                    item["refs"].insert(1, _ref(a))  # same message, another copy: extra support, not a new finding
                continue
            add("AMOUNT_MISMATCH", 3, f"Amount differs for {ik.split(':', 1)[1]}: {fmt_money(max(aa))} vs {fmt_money(max(ab))}",
                f"{_ev_name(ev_by_id, a)} mentions {fmt_money(max(aa))} but {_ev_name(ev_by_id, b)} records {fmt_money(max(ab))} for {ik.split(':', 1)[1]}.",
                [_ref(a), _ref(b)], 0.75, identifier=ik)
            seen_amount[sig] = out[-1]

    # X5: statement vs evidence — same amount/identifier/location, dates differ by > 1 day.
    stmt = [e for e in events if e["sourceType"] == "self_statement"]
    docs_ev = [e for e in events if e["sourceType"] == "document"]
    for s, d in product(stmt, docs_ev):
        # Same transaction: equal amounts when both state one; otherwise a shared identifier (not just a place).
        if s["amount"] and d["amount"]:
            shared = s["amount"] == d["amount"]
        else:
            shared = bool(set(s["identifiers"]) & set(d["identifiers"])) and not (s["amount"] or d["amount"])
        ts, td = parse_ts(s["ts"]), parse_ts(d["ts"])
        if shared and ts and td and abs((ts - td).days) > 1:
            sc, dc = by_id.get(s["citations"][0]), by_id.get(d["citations"][0])
            if sc and dc:
                add("DATE_CONFLICT", 2, "Your statement and the evidence give different dates",
                    f"Your statement places this on {s['ts'][:10]}, while {_ev_name(ev_by_id, dc)} shows {d['ts'][:10]}. Check before filing.",
                    [_ref(sc), _ref(dc)], 0.7, subtype="statement_vs_evidence")

    out.sort(key=lambda o: (-o["severity"], -o["confidence"]))
    return out


def _amounts(c: dict) -> set[int]:
    return {e["norm"] for e in c.get("entities", []) if e["type"] == "MONEY" and e.get("norm")}


def _neighbour_amounts(c: dict, chunks: list[dict]) -> set[int]:
    for o in chunks:
        if o["evidenceId"] == c["evidenceId"] and abs(o["idx"] - c["idx"]) <= 2 and o.get("sender") == c.get("sender"):
            a = _amounts(o)
            if a:
                return a
    return set()


def _doc_time(c: dict) -> str | None:
    t = c.get("times") or []
    return t[0]["ts"] if t else c.get("refTs")


def _ev_name(ev_by_id: dict, c: dict) -> str:
    e = ev_by_id.get(c["evidenceId"], {})
    return e.get("sourceLabel") or e.get("filename") or "another item"
