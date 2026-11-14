"""Event extraction, cross-source merging and timeline building (spec N5, T1–T9).

Deterministic path (also the offline fallback): every chunk with severity ≥ 1, a MONEY
amount, or a LOCATION becomes an event. Events cite the chunk IDs they came from; an
LLM path may later refine titles but must cite only input IDs.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from rapidfuzz import fuzz

from .common import chunk_text_en, fmt_money, parse_ts, quote, stable_key

MERGE_WINDOW_S = 600
MERGE_SIM = 0.85
CATEGORY_ORDER = ["extortion", "threat", "sexual", "abuse", "financial_request"]
CATEGORY_LABEL = {
    "extortion": "extortion demand", "threat": "threat", "sexual": "sexual harassment", "abuse": "abusive message",
    "financial_request": "money request", "payment": "payment", "meeting": "meeting / location", "contact": "contact",
}


def _infer_missing_times(chunks: list[dict]) -> None:
    """T8: a chunk with no time takes its nearest timed neighbour in the same evidence (approx)."""
    by_ev: dict[str, list[dict]] = defaultdict(list)
    for c in chunks:
        by_ev[c["evidenceId"]].append(c)
    for cs in by_ev.values():
        cs.sort(key=lambda c: c["idx"])
        for i, c in enumerate(cs):
            if c.get("refTs"):
                continue
            for j in range(1, len(cs)):
                for k in (i - j, i + j):
                    if 0 <= k < len(cs) and cs[k].get("refTs") and not cs[k].get("tsInferred"):
                        c["refTs"], c["tsInferred"] = cs[k]["refTs"], True
                        break
                if c.get("refTs"):
                    break


def _event_time(c: dict, kind: str | None = None) -> tuple[str | None, str]:
    """Messages/emails: when they were sent. Statements and documents (PDF rows): the time they describe."""
    times = c.get("times") or []
    if c.get("sourceType") == "self_statement" or kind == "pdf":
        if times:
            return times[0]["ts"], times[0].get("precision", "day")
    if c.get("refTs"):
        if c.get("tsInferred"):
            return c["refTs"], "approx"
        ts = c["refTs"]
        return ts, "day" if ts.endswith("T00:00:00") else "exact"
    if times:
        return times[0]["ts"], times[0].get("precision", "approx")
    return None, "unknown"


def extract(chunks: list[dict], resolved: dict, evidence_by_id: dict[str, dict], owner_key: str | None) -> list[dict]:
    _infer_missing_times(chunks)
    mentions = resolved["mentions"]
    alias = resolved["aliasToEntity"]
    participants: dict[str, set[str]] = defaultdict(set)
    for c in chunks:
        if c.get("sender"):
            k = alias.get(_alias_key(c["sender"], resolved), None)
            if k:
                participants[c["evidenceId"]].add(k)

    events = []
    for c in chunks:
        ents = c.get("entities") or []
        sev = (c.get("severity") or {}).get("score", 0)
        labels = (c.get("severity") or {}).get("labels", [])
        money = [e for e in ents if e["type"] == "MONEY"]
        locs = [e for e in ents if e["type"] == "LOCATION"]
        kind = evidence_by_id.get(c["evidenceId"], {}).get("kind")
        if kind == "pdf":
            money = [e for e in money if e.get("direction") != "credit"]
            locs = []  # addresses in letterheads/statements are not meetings
        if sev < 1 and not money and not locs:
            continue
        ev = evidence_by_id.get(c["evidenceId"], {})
        cat = next((l for l in CATEGORY_ORDER if l in labels), None)
        if money and ev.get("kind") == "pdf" and not set(labels) & {"extortion", "threat", "sexual", "abuse"}:
            cat = "payment"
        if not cat:
            cat = "payment" if money and ev.get("kind") in ("pdf", "email") else ("meeting" if locs else ("financial_request" if money else "contact"))
        actor = None
        if c.get("sender"):
            actor = alias.get(_alias_key(c["sender"], resolved))
        targets = sorted(participants.get(c["evidenceId"], set()) - {actor} - {None})
        if not targets and owner_key and actor != owner_key:
            targets = [owner_key]
        ts, prec = _event_time(c, ev.get("kind"))
        amount = max((e["norm"] for e in money), default=None)
        location = locs[0]["norm"] if locs else None
        ids = [m["entityKey"] for m in mentions.get(c["id"], []) if m["type"] in ("UPI_ID", "BANK_ACCT", "PHONE", "EMAIL", "HANDLE")]
        actor_name = _name(actor, resolved) or (c.get("sender") or "Unknown")
        if actor and actor == owner_key and cat == "financial_request":
            cat = "contact"
        title = _title(cat, actor_name, amount, location, ids, c.get("sourceType"))
        if actor and actor == owner_key and cat == "contact":
            title = f"{actor_name} replied about payment" if set(labels) & {"financial_request"} else f"{actor_name} replied"
        events.append({
            "key": stable_key("event", c["id"]), "ts": ts, "tsPrecision": prec, "title": title,
            "description": quote(c.get("text", ""), 280), "descriptionEn": quote(chunk_text_en(c), 280) if c.get("textEn") and c.get("textEn") != c.get("text") else None,
            "category": cat, "severity": sev, "labels": labels, "actors": [actor] if actor else [], "targets": targets,
            "location": location, "amount": amount, "identifiers": sorted(set(ids)), "citations": [c["id"]],
            "evidenceIds": [c["evidenceId"]], "sourceType": c.get("sourceType", "document"),
            "lane": ev.get("sourceLabel") or ev.get("filename") or c["evidenceId"],
            "confidence": round(0.9 if prec == "exact" else 0.7 if prec == "day" else 0.5, 2),
            "audio": {"evidenceId": c["evidenceId"], **c["locator"]} if c.get("unit") == "segment" else None,
            "_text": chunk_text_en(c),
        })
    return events


def _alias_key(name: str, resolved: dict) -> str:
    from .common import norm_name

    n = norm_name(name)
    if n in {"me", "you", "i", "myself", "complainant"}:
        owner = next((e for e in resolved["entities"] if e.get("isOwner")), None)
        return owner["key"] if owner else "PERSON:complainant"
    return f"PERSON:{n}"


def _name(key: str | None, resolved: dict) -> str | None:
    if not key:
        return None
    return next((e["name"] for e in resolved["entities"] if e["key"] == key), None)


def _title(cat: str, actor: str, amount, location, ids, source_type) -> str:
    who = actor
    if cat == "payment":
        t = f"Payment of {fmt_money(amount)}" + (f" to {ids[0].split(':', 1)[1]}" if ids else "")
    elif cat == "financial_request":
        t = f"{who} asked for {fmt_money(amount) if amount else 'money'}" + (f" via {ids[0].split(':', 1)[1]}" if ids else "")
    elif cat == "meeting":
        t = f"{who} named a place: {location}"
    else:
        t = f"{who}: {CATEGORY_LABEL[cat]}"
        if amount:
            t += f" ({fmt_money(amount)})"
        if location:
            t += f" — {location}"
    return ("Complainant's account: " + t) if source_type == "self_statement" else t


def merge(events: list[dict]) -> list[dict]:
    """T7: merge events across sources (shared actor, ±10 min, similar text). Self-statements never merge into documents."""
    events.sort(key=lambda e: (e["ts"] or "9999", e["key"]))
    merged: list[dict] = []
    for e in events:
        t = parse_ts(e["ts"])
        target = None
        for m in reversed(merged[-50:]):
            tm = parse_ts(m["ts"])
            if not (t and tm) or abs((t - tm).total_seconds()) > MERGE_WINDOW_S:
                continue
            if m["sourceType"] != e["sourceType"] or set(m["evidenceIds"]) & set(e["evidenceIds"]):
                continue
            if not (set(m["actors"]) & set(e["actors"])):
                continue
            if fuzz.token_set_ratio(m["_text"], e["_text"]) / 100 >= MERGE_SIM:
                target = m
                break
        if target:
            target["citations"] = sorted(set(target["citations"]) | set(e["citations"]))
            target["evidenceIds"] = sorted(set(target["evidenceIds"]) | set(e["evidenceIds"]))
            target["severity"] = max(target["severity"], e["severity"])
            target["identifiers"] = sorted(set(target["identifiers"]) | set(e["identifiers"]))
            if target["tsPrecision"] != "exact" and e["tsPrecision"] == "exact":
                target["ts"], target["tsPrecision"] = e["ts"], "exact"
            target["key"] = stable_key("event", *target["citations"])
        else:
            merged.append(e)
    return merged


def finalize(events: list[dict], overrides: dict[str, dict] | None = None) -> dict:
    overrides = overrides or {}
    for e in events:
        docs = {eid for eid in e["evidenceIds"]} if e["sourceType"] == "document" else set()
        e["corroborationCount"] = max(0, len(docs) - 1)
        e.pop("_text", None)
        ov = overrides.get(e["key"])
        if ov:
            e.update({k: v for k, v in ov.items() if k in ("ts", "title", "category", "tsPrecision")})
            e["userEdited"] = True
        t = parse_ts(e["ts"])
        if t and e["tsPrecision"] == "approx":
            e["tsEnd"] = (t + timedelta(hours=6)).isoformat()
        elif t and e["tsPrecision"] == "day":
            e["tsEnd"] = (t + timedelta(days=1)).isoformat()
    events.sort(key=lambda e: (e["ts"] or "9999", -e["severity"]))
    key_moments = sorted([e for e in events if e["severity"] >= 1], key=lambda e: -(e["severity"] * e["confidence"]))[:5]
    return {"events": events, "keyMoments": [e["key"] for e in key_moments]}
