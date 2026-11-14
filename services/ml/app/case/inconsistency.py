"""Inconsistency detection (spec N7, X1–X5): rules over metadata, duplicates, amounts,
senders, sequence and the complainant's statement vs documentary evidence.

Each item quotes the ORIGINAL text of both sides. `key` is stable across rebuilds so a
dismissal or explanation note survives reprocessing.
"""
from __future__ import annotations

from collections import defaultdict
from itertools import product

from .common import fmt_money, parse_ts, quote, stable_key
from .dedup import TZ_SLACK_S

FLAG_SEVERITY = {"EDITED_FILE": 2, "METADATA_MISMATCH": 2, "IMPOSSIBLE_SEQUENCE": 2, "SENDER_MISMATCH": 2}
FIN_IDS = ("UPI_ID", "BANK_ACCT", "PHONE")
SELF_ALIASES = {"me", "you", "i", "myself", "complainant"}
MIN_WORDS_SENDER = 4  # spec §4.2: shorter messages repeat naturally
BURST_LIMIT = 3  # spec §3: more than this many same-type flags between one evidence pair -> one parent flag
AMOUNT_WINDOW_DAYS = 2  # spec §4.1
MIN_CONFIDENCE = 0.55  # spec §8 emit threshold


def _close_enough(a: set[int], b: set[int]) -> bool:
    """Amounts within 1% or ₹1 are rounding, within 2% / ₹10 are fee noise (spec §4.1, §5)."""
    return any(abs(x - y) <= max(10, 0.02 * max(x, y)) for x in a for y in b)


def _ref(c: dict) -> dict:
    return {"evidenceId": c["evidenceId"], "chunkId": c["id"], "quote": quote(c.get("text", ""), 200),
            "quoteEn": quote(c["textEn"], 200) if c.get("textEn") and c.get("textEn") != c.get("text") else None}


def detect(evidence: list[dict], chunks: list[dict], dedup: dict, resolved: dict, events: list[dict]) -> list[dict]:
    by_id = {c["id"]: c for c in chunks}
    ev_by_id = {e["id"]: e for e in evidence}
    out: list[dict] = []

    def add(t: str, sev: int, title: str, explanation: str, refs: list[dict], confidence: float, **extra) -> None:
        if confidence < MIN_CONFIDENCE:
            return
        # Never compare an item with itself / its exact copy (spec G1).
        if len({r["evidenceId"] for r in refs}) < 2 and t in ("SENDER_MISMATCH", "AMOUNT_MISMATCH", "CONTENT_CONTRADICTION"):
            return
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
            sev = FLAG_SEVERITY[t]
            if t == "METADATA_MISMATCH" and f.get("contentDate") and f.get("captureDate"):
                # Capture before the content date is impossible; a gap over 7 days is harmful (spec §4.3).
                cd, cap = f["contentDate"], f["captureDate"]
                gap_days = (parse_ts(cap) - parse_ts(cd)).days if parse_ts(cap) and parse_ts(cd) else 0
                if gap_days < 0 or gap_days > 7:
                    sev = 3
            add(t, sev, titles[t], f"{f.get('field')}: {f.get('value')}.", [ref], 0.9)

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
    # Spec §4.2: resolve "Me/You" to the device owner first; skip generic short messages; if the owner is
    # unknown or labels flip in bulk, raise ONE parent flag per evidence pair asking who "Me" is.
    alias = resolved["aliasToEntity"]
    from .common import norm_name
    from .events import _alias_key

    owner_known = any(e.get("isOwner") for e in resolved["entities"])
    pair_hits: dict[tuple, list[tuple[dict, dict, bool]]] = defaultdict(list)
    for g in dedup.get("groups", []):
        if g["kind"] != "cross_modal":
            continue
        a, b = (by_id.get(m.get("chunkId")) for m in g["members"])
        if not a or not b or a["evidenceId"] == b["evidenceId"] or not a.get("sender") or not b.get("sender"):
            continue
        if len((a.get("text") or "").split()) < MIN_WORDS_SENDER:
            continue  # "ok", "thanks", emoji: repeats naturally
        ka, kb = _alias_key(a["sender"], resolved), _alias_key(b["sender"], resolved)
        sa, sb = alias.get(ka) or ka, alias.get(kb) or kb
        if sa == sb:
            continue
        self_side = norm_name(a["sender"]) in SELF_ALIASES or norm_name(b["sender"]) in SELF_ALIASES
        pair_hits[tuple(sorted((a["evidenceId"], b["evidenceId"])))].append((a, b, self_side and not owner_known))
    for pair, hits in pair_hits.items():
        unsure = any(h[2] for h in hits)
        if unsure or len(hits) > BURST_LIMIT:
            a, b, _ = hits[0]
            n1, n2 = _ev_name(ev_by_id, a), _ev_name(ev_by_id, b)
            add("SENDER_MISMATCH", 1, f"Speaker labels differ between {n1} and {n2} ({len(hits)} message{'s' if len(hits) > 1 else ''})",
                f"The same messages are attributed to different speakers (e.g. {a['sender']} vs {b['sender']}). This is usually a perspective or alias "
                f"issue (\"Me\" in a screenshot is the phone owner). Confirm who \"Me\" is before treating it as tampering.",
                [_ref(h[i]) for h in hits[:2] for i in (0, 1)], 0.6, subtype="speaker_labels",
                reasonChecked=["not a duplicate pair", "short messages excluded", "owner unresolved or labels flip in bulk"])
            continue
        for a, b, _ in hits:
            long_msg = len((a.get("text") or "").split()) >= 10
            add("SENDER_MISMATCH", 2, "Same message attributed to different senders",
                f"{_ev_name(ev_by_id, a)} shows it from {a['sender']}, {_ev_name(ev_by_id, b)} from {b['sender']}.",
                [_ref(a), _ref(b)], 0.7 if long_msg else 0.6,
                reasonChecked=["Me/You resolved to owner", "aliases resolved", "not a duplicate pair"])

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
            if _close_enough(aa, ab):
                continue  # rounding / fee noise (spec §4.1)
            ta, tb = parse_ts(a.get("refTs")), parse_ts(_doc_time(b))
            if ta and tb and abs((ta - tb).total_seconds()) > AMOUNT_WINDOW_DAYS * 86400:
                continue
            # Another debit to the same identifier in the window may be the matching one, or several may sum to it.
            window_docs = [d for d in docs if d["evidenceId"] != a["evidenceId"]
                           and (not ta or not parse_ts(_doc_time(d)) or abs((ta - parse_ts(_doc_time(d))).total_seconds()) <= AMOUNT_WINDOW_DAYS * 86400)]
            all_amts = [x for d in window_docs for x in _amounts(d)]
            if aa & set(all_amts) or any(sum(all_amts) == x for x in aa):
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
        if shared and ts and td and abs((ts - td).total_seconds()) > 86400 + TZ_SLACK_S:
            sc, dc = by_id.get(s["citations"][0]), by_id.get(d["citations"][0])
            if sc and dc:
                add("DATE_CONFLICT", 2, "Your statement and the evidence give different dates",
                    f"Your statement places this on {s['ts'][:10]}, while {_ev_name(ev_by_id, dc)} shows {d['ts'][:10]}. Check before filing.",
                    [_ref(sc), _ref(dc)], 0.7, subtype="statement_vs_evidence")

    _coverage_gaps(chunks, ev_by_id, dedup, add)

    out.sort(key=lambda o: (-o["severity"], -o["confidence"]))
    return out


def _coverage_gaps(chunks: list[dict], ev_by_id: dict, dedup: dict, add) -> None:
    """Spec §6: a screenshot message missing from a full export that covers its time window.
    Info-level only (severity 1), worded as 'not found', never as a conflict."""
    from rapidfuzz import fuzz

    from .common import norm_name

    exports: dict[str, list[dict]] = defaultdict(list)
    for c in chunks:
        if c.get("unit") == "message" and c.get("refTs"):
            exports[c["evidenceId"]].append(c)
    if not exports:
        return
    paired = {m.get("chunkId") for g in dedup.get("groups", []) for m in g["members"]}
    paired |= {p["visualChunkId"] for p in dedup.get("contradictions", [])}
    for c in chunks:
        if c.get("unit") != "bubble" or c["id"] in paired or c.get("lowConfidence"):
            continue
        text, tc = norm_name(c.get("text") or ""), parse_ts(c.get("refTs"))
        if len(text.split()) < 6 or not tc:
            continue
        covering = []
        for eid, ms in exports.items():
            times = [t for t in (parse_ts(m["refTs"]) for m in ms) if t]
            if times and min(times) <= tc <= max(times):
                covering.append((eid, ms))
        if not covering:
            continue  # no export covers this moment
        if any(fuzz.token_set_ratio(text, norm_name(m.get("text") or "")) >= 60 for _, ms in exports.items() for m in ms):
            continue
        for eid, ms in covering[:1]:
            name =(ev_by_id.get(eid) or {}).get("sourceLabel") or (ev_by_id.get(eid) or {}).get("filename") or "the chat export"
            add("COVERAGE_GAP", 1, "Message not found in the chat export",
                f"This screenshot message was not found in {name}, although the export covers {tc.date()}. It may have been deleted, or the screenshot may not match the export.",
                [_ref(c)], 0.6, subtype="not_in_export", reasonChecked=["export covers the time window", "fuzzy-matched entire export"])
            break


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
