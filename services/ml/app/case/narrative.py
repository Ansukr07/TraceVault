"""Voice statement → written first-person narrative + prefill suggestions (spec §6.4, V-INTAKE).

Every sentence cites the transcript segment it came from. Without an LLM, the draft is the transcript itself,
lightly cleaned (fillers removed, one sentence per segment), which is supported by construction. With an LLM
the model may rephrase, but cited ids are validated against the input and unsupported sentences are dropped.
Suggestions are never applied automatically.
"""
from __future__ import annotations

import re
from collections import Counter

from ..lang.redact import redact, restore
from ..llm.client import complete_json
from ..nlp import ner, severity

PROMPT_VERSION = "narrative-v1"
_FILLER = re.compile(r"\b(um+|uh+|umm+|hmm+|you know|like,|basically|matlab|jaise ki|toh phir|haan to)\b[,\s]*", re.IGNORECASE)
_CITE = re.compile(r"\[(E\d+:\d+)\]")


def _clean(t: str) -> str:
    t = _FILLER.sub("", t or "")
    t = re.sub(r"\s+", " ", t).strip()
    if t and t[-1] not in ".!?।":
        t += "."
    return t[:1].upper() + t[1:] if t and t[0].isascii() else t


def incident_type(texts: list[str]) -> tuple[str, float]:
    labels: Counter = Counter()
    for t in texts:
        for l in severity.classify(t)["labels"]:
            labels[l] += 1
    blob = " ".join(texts).lower()
    if labels["sexual"] and (labels["extortion"] or labels["threat"] or labels["financial_request"]):
        return "sextortion", 0.8
    if re.search(r"\b(follow(ed|ing)?|stalk\w*|watching me|outside my (house|college|office)|peecha|पीछा)\b", blob):
        return "stalking", 0.65
    if labels["financial_request"] and re.search(r"\b(upi|paid|payment|transferred|bank|otp|scam|fraud|cheat\w*|dhoka|ठग)\b", blob):
        return "fraud", 0.7
    if labels["threat"] or labels["abuse"] or labels["extortion"]:
        return "harassment", 0.6
    return "other", 0.3


def suggestions(segments: list[dict], ref_ts: str | None) -> dict:
    ents: list[dict] = []
    for s in segments:
        text = s.get("textEn") or s["text"]
        for e in ner.extract(s["text"], ref_ts=ref_ts, text_en=s.get("textEn")):
            ents.append({**e, "chunkId": s["id"]})
        if s.get("textEn") and s["textEn"] != s["text"]:
            for e in ner.extract(s["textEn"], ref_ts=ref_ts):
                ents.append({**e, "chunkId": s["id"]})

    def uniq(types: tuple[str, ...], key=lambda e: str(e["norm"]).lower()) -> list[dict]:
        seen, out = set(), []
        for e in ents:
            if e["type"] in types and key(e) not in seen:
                seen.add(key(e))
                out.append({"value": e["norm"] if e["type"] not in ("PERSON", "LOCATION") else e["text"], "text": e["text"], "type": e["type"], "chunkId": e["chunkId"],
                            **({"precision": e["precision"]} if "precision" in e else {})})
        return out

    texts = [s.get("textEn") or s["text"] for s in segments]
    itype, conf = incident_type(texts + [s["text"] for s in segments])
    return {
        "incidentType": {"value": itype, "confidence": conf},
        "people": uniq(("PERSON",), key=lambda e: str(e["norm"]).lower().split()[0]),
        "phones": uniq(("PHONE",)),
        "payments": uniq(("UPI_ID", "BANK_ACCT")),
        "handles": uniq(("HANDLE", "EMAIL")),
        "amounts": uniq(("MONEY",)),
        "dates": uniq(("DATE", "TIME")),
        "locations": uniq(("LOCATION",)),
    }


SYSTEM = (
    "You turn a victim's spoken statement into a clear, calm, first-person written statement for a complaint. "
    "Use ONLY what the numbered transcript segments say; never add facts, names, dates or amounts. Keep the person's "
    "own meaning. Every sentence ends with the citation of the segment(s) it comes from, like [E9:2]. "
    'Output JSON {"sentences":["... [E9:2]"]} in English.'
)


async def draft(segments: list[dict], *, lang: str | None, mode: str, ref_ts: str | None, pii: dict[str, str] | None = None) -> dict:
    """segments: [{id, text, textEn?, lang?}] in spoken order. Returns the statement payload."""
    ok = [s for s in segments if s.get("text") and s["text"] != "[untranscribed]"]
    sugg = suggestions(ok, ref_ts)
    allowed = {s["id"] for s in ok}
    sentences: list[dict] = []
    generator = {"name": "transcript-cleanup", "version": 1}

    if ok:
        lines = [f"[{s['id']}] {s.get('textEn') or s['text']}" for s in ok]
        user = "TRANSCRIPT SEGMENTS:\n" + "\n".join(lines)
        redacted = mode == "cloud_redacted"
        mapping: dict[str, str] = {}
        if redacted:
            user, mapping = redact(user, pii)
        data, meta = await complete_json(SYSTEM, user, mode=mode, purpose="summary", max_tokens=2000)
        if data and isinstance(data.get("sentences"), list):
            for raw in data["sentences"]:
                txt = restore(str(raw), mapping)[0] if redacted else str(raw)
                cites = [c for c in _CITE.findall(txt) if c in allowed]
                clean = re.sub(r"\s+([.,;])", r"\1", _CITE.sub("", txt).strip())
                if cites and clean:
                    sentences.append({"text": clean, "citations": cites})
            if sentences:
                generator = {"name": "llm", "version": 1, "promptVersion": PROMPT_VERSION, **meta}
        if not sentences:
            for s in ok:
                en = _clean(s.get("textEn") or s["text"])
                if en:
                    sentences.append({"text": en, "citations": [s["id"]]})

    native = " ".join(_clean(s["text"]) for s in ok)
    english = " ".join(x["text"] for x in sentences)
    return {
        "lang": lang, "textNative": native, "textEn": english, "sentences": sentences, "suggestions": sugg,
        "generator": generator, "segments": len(ok), "untranscribed": len(segments) - len(ok),
    }
