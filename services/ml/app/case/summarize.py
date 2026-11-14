"""Cited case summary + Q&A (spec N9, N10, S1–S6).

Every sentence carries chunk citations; IDs are validated against the context given to the
generator (never trust model output). Support is checked lexically (key terms, numbers and
names of the sentence must appear in the cited chunks); unsupported sentences get ⚠.
Without an LLM, a deterministic template summary is produced from the structured data —
supported by construction.
"""
from __future__ import annotations

import math
import re
from collections import Counter

from ..lang.redact import redact, restore
from ..llm.client import complete_json
from .common import fmt_date, fmt_money, quote

SECTIONS = ["Overview", "Parties involved", "Chronology", "Threats & harm", "Financial loss", "Inconsistencies & gaps"]
PROMPT_VERSION = "summary-v1"
_CITE = re.compile(r"\[(E\d+:\d+)\]")
_STOP = set("the a an and or of to in on at for with by from is was were be been are this that it as his her their they he she i you we "
            "about after before into over not no but also which who whom has have had did does do said says sent".split())


def _s(text: str, cites: list[str]) -> dict:
    return {"text": text, "citations": list(dict.fromkeys(c for c in cites if c))[:4]}


def template_summary(case: dict, chunks: dict[str, dict], entities: list[dict], events: list[dict],
                     inconsistencies: list[dict], evidence: list[dict]) -> dict:
    sec: dict[str, list[dict]] = {s: [] for s in SECTIONS}
    dated = [e for e in events if e.get("ts")]
    kinds = Counter(e["kind"] for e in evidence)
    kind_txt = ", ".join(f"{n} {k.replace('_', ' ')}{'s' if n > 1 else ''}" for k, n in kinds.most_common())
    if dated:
        sec["Overview"].append(_s(
            f"The case file contains {len(evidence)} evidence items ({kind_txt}) with events from {fmt_date(dated[0]['ts'], 'day')} "
            f"to {fmt_date(dated[-1]['ts'], 'day')}.", [dated[0]["citations"][0], dated[-1]["citations"][0]]))
    severe = [e for e in events if e["severity"] >= 2 and e["sourceType"] == "document"]
    if severe:
        sec["Overview"].append(_s(f"{len(severe)} messages were classified as threatening, sexual or extortionate.",
                                  [e["citations"][0] for e in sorted(severe, key=lambda e: -e["severity"])[:3]]))

    people = [e for e in entities if e["type"] == "PERSON"]
    owner = next((p for p in people if p.get("isOwner")), None)
    for p in [p for p in people if not p.get("isOwner")][:5]:
        idents = [v for vs in p.get("identifiers", {}).values() for v in vs]
        txt = f"{p['name']} appears in {len(p['evidenceIds'])} evidence item{'s' if len(p['evidenceIds']) != 1 else ''}"
        if len(p.get("aliases", [])) > 1:
            txt += f" under the names {', '.join(p['aliases'])}"
        if idents:
            txt += f" and is linked to {', '.join(idents[:3])}"
        sec["Parties involved"].append(_s(txt + ".", p["mentionChunkIds"][:3]))
    if owner:
        sec["Parties involved"].append(_s(f"{owner['name']} is the complainant.", owner["mentionChunkIds"][:1]))

    for e in sorted(dated, key=lambda e: (-e["severity"], e["ts"]))[:10][::-1] if len(dated) > 10 else dated:
        prefix = "According to the complainant, " if e["sourceType"] == "self_statement" else ""
        sec["Chronology"].append(_s(f"{prefix}On {fmt_date(e['ts'], e['tsPrecision'])}: {e['title']}.", e["citations"]))
    sec["Chronology"].sort(key=lambda s: next((e["ts"] for e in dated if e["citations"] and e["citations"][0] in s["citations"]), ""))

    for e in sorted([e for e in events if e["severity"] >= 2], key=lambda e: (e["ts"] or ""))[:8]:
        c = chunks.get(e["citations"][0], {})
        q = quote(c.get("text", ""), 120)
        actor = e["title"].split(":")[0]
        labels = ", ".join(l.replace("_", " ") for l in e["labels"] if l != "financial_request") or "harmful"
        prefix = "According to the complainant, " if e["sourceType"] == "self_statement" else ""
        sec["Threats & harm"].append(_s(f"{prefix}On {fmt_date(e['ts'], e['tsPrecision'])}, {actor} sent a message classified as {labels}: “{q}”.", e["citations"]))

    payments = [e for e in events if e["category"] == "payment" and e["amount"] and any(i.startswith(("UPI_ID:", "BANK_ACCT:")) for i in e["identifiers"])]
    requests = [e for e in events if e["category"] in ("financial_request", "extortion") and e["amount"]]
    for e in payments[:6]:
        sec["Financial loss"].append(_s(f"{e['title']} is recorded on {fmt_date(e['ts'], e['tsPrecision'])}.", e["citations"]))
    if payments:
        total = sum(e["amount"] for e in payments)
        sec["Financial loss"].append(_s(f"Payments recorded in financial documents total {fmt_money(total)}.", [e["citations"][0] for e in payments[:4]]))
    for e in requests[:4]:
        sec["Financial loss"].append(_s(f"On {fmt_date(e['ts'], e['tsPrecision'])}, {fmt_money(e['amount'])} was demanded.", e["citations"]))

    for i in inconsistencies[:8]:
        cites = [r["chunkId"] for r in i["refs"] if r.get("chunkId")]
        if cites:
            sec["Inconsistencies & gaps"].append(_s(f"{i['title']}: {i['explanation']}", cites))
        else:
            ev_idx = {e["id"]: e["idx"] for e in evidence}
            cites = [f"E{ev_idx[r['evidenceId']]}" for r in i["refs"] if r["evidenceId"] in ev_idx]
            sec["Inconsistencies & gaps"].append(_s(f"{i['title']}: {i['explanation']}", cites))
    for s in sec.values():
        for x in s:
            x["supported"] = True
    return {"sections": [{"title": t, "sentences": sec[t]} for t in SECTIONS], "generator": {"name": "template", "version": 1}}


def _terms(text: str) -> set[str]:
    return {w for w in re.findall(r"[\w₹]+", text.lower()) if w not in _STOP and len(w) > 2}


def support_score(sentence: str, cited_texts: list[str]) -> float:
    st = _terms(sentence)
    if not st:
        return 1.0
    ct = set().union(*(_terms(t) for t in cited_texts)) if cited_texts else set()
    nums = {w for w in st if any(ch.isdigit() for ch in w)}
    if nums - ct:
        return 0.3
    return len(st & ct) / len(st)


def _context(chunks: dict[str, dict], events: list[dict], limit: int = 220) -> list[dict]:
    chosen: list[str] = []
    for e in sorted(events, key=lambda e: -e["severity"]):
        for c in e["citations"]:
            if c not in chosen:
                chosen.append(c)
    for cid in chunks:
        if len(chosen) >= limit:
            break
        if cid not in chosen:
            chosen.append(cid)
    return [chunks[c] for c in chosen[:limit] if c in chunks]


SYSTEM = (
    "You write factual case summaries for victims of online harassment and fraud in India, for lawyers and police. "
    "Use ONLY the numbered evidence chunks provided. Every sentence must end with one or more citations like [E1:3] "
    "that support it. Never invent names, dates, amounts or events. Facts that come only from chunks marked SELF are "
    "the complainant's own account: write 'According to the complainant'. Output JSON: "
    '{"sections":[{"title":"Overview","sentences":["... [E1:2]"]}, ...]} with sections exactly: ' + ", ".join(SECTIONS) + "."
)


async def llm_summary(mode: str, case: dict, chunks: dict[str, dict], events: list[dict], inconsistencies: list[dict],
                      pii: dict[str, str]) -> dict | None:
    ctx = _context(chunks, events)
    allowed = {c["id"] for c in ctx}
    redacted = mode == "cloud_redacted"
    lines, mapping = [], {}
    for c in ctx:
        txt = c.get("textEn") or c.get("text") or ""
        tag = "SELF " if c.get("sourceType") == "self_statement" else ""
        lines.append(f"[{c['id']}] {tag}{c.get('refTs') or ''} {c.get('sender') or ''}: {txt}")
    incs = "\n".join(f"- {i['title']}: {i['explanation']} (cite {', '.join(r['chunkId'] for r in i['refs'] if r.get('chunkId'))})" for i in inconsistencies[:10])
    user = f"Case: {case.get('title')} ({case.get('incidentType')}).\n\nEVIDENCE CHUNKS:\n" + "\n".join(lines) + f"\n\nDETECTED INCONSISTENCIES:\n{incs or 'none'}"
    if redacted:
        # Placeholders must be consistent across the whole prompt: one mapping for everything.
        user, mapping = redact(user, pii)
    data, meta = await complete_json(SYSTEM, user, mode=mode)
    if not data or "sections" not in data:
        return None
    out = []
    for sec in data["sections"]:
        if sec.get("title") not in SECTIONS:
            continue
        sents = []
        for raw in sec.get("sentences", []):
            if not isinstance(raw, str):
                continue
            text = restore(raw, mapping)[0] if redacted else raw
            cites = [c for c in _CITE.findall(text)]
            valid = [c for c in cites if c in allowed]
            clean = _CITE.sub("", text).strip()
            clean = re.sub(r"\s+([.,;])", r"\1", clean)
            if not valid:
                continue  # every shown sentence must carry a valid citation (S2)
            score = support_score(clean, [(chunks[c].get("textEn") or "") + " " + (chunks[c].get("text") or "") for c in valid])
            sents.append({"text": clean, "citations": valid, "supported": score >= 0.5, "support": round(score, 2),
                          "droppedCitations": [c for c in cites if c not in allowed] or None})
        out.append({"title": sec["title"], "sentences": sents})
    titles = {s["title"] for s in out}
    out += [{"title": t, "sentences": []} for t in SECTIONS if t not in titles]
    out.sort(key=lambda s: SECTIONS.index(s["title"]))
    return {"sections": out, "generator": {"name": "llm", "version": 1, "promptVersion": PROMPT_VERSION, **meta}}


# ------------------------------------------------------------------ Q&A
def _bm25(query: str, docs: list[tuple[str, str]], k: int = 6) -> list[tuple[str, float]]:
    q = _terms(query)
    if not q:
        return []
    toks = {i: Counter(re.findall(r"[\w₹]+", t.lower())) for i, t in docs}
    n = len(docs)
    avg = sum(sum(c.values()) for c in toks.values()) / max(n, 1)
    df = Counter(w for c in toks.values() for w in set(c))
    scores = []
    for i, c in toks.items():
        dl = sum(c.values())
        s = 0.0
        for w in q:
            if w in c:
                idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * c[w] * 2.2 / (c[w] + 1.2 * (0.25 + 0.75 * dl / max(avg, 1)))
        if s > 0:
            scores.append((i, s))
    return sorted(scores, key=lambda x: -x[1])[:k]


async def answer(question: str, mode: str, chunks: dict[str, dict], pii: dict[str, str]) -> dict:
    docs = [(cid, f"{c.get('sender') or ''} {c.get('text') or ''} {c.get('textEn') or ''}") for cid, c in chunks.items()]
    hits = _bm25(question, docs)
    if not hits:
        return {"answer": "I could not find anything in the evidence about that.", "sentences": [], "generator": {"name": "retrieval"}}
    ctx = [chunks[i] for i, _ in hits]
    allowed = {c["id"] for c in ctx}
    lines = [f"[{c['id']}] {'SELF ' if c.get('sourceType') == 'self_statement' else ''}{c.get('refTs') or ''} {c.get('sender') or ''}: {c.get('textEn') or c.get('text')}" for c in ctx]
    user = f"Question: {question}\n\nEVIDENCE:\n" + "\n".join(lines)
    redacted = mode == "cloud_redacted"
    mapping: dict[str, str] = {}
    if redacted:
        user, mapping = redact(user, pii)
    system = ("Answer the question using ONLY the evidence chunks. Every sentence ends with citations like [E1:3]. "
              "If the evidence does not answer it, say so. Output JSON {\"sentences\":[\"... [E1:3]\"]}.")
    data, meta = await complete_json(system, user, mode=mode, purpose="summary", max_tokens=1200)
    if data and isinstance(data.get("sentences"), list):
        sents = []
        for raw in data["sentences"]:
            text = restore(str(raw), mapping)[0] if redacted else str(raw)
            valid = [c for c in _CITE.findall(text) if c in allowed]
            clean = re.sub(r"\s+([.,;])", r"\1", _CITE.sub("", text).strip())
            if valid:
                score = support_score(clean, [(chunks[c].get("textEn") or "") + " " + (chunks[c].get("text") or "") for c in valid])
                sents.append({"text": clean, "citations": valid, "supported": score >= 0.5})
        if sents:
            return {"answer": " ".join(s["text"] for s in sents), "sentences": sents, "generator": {"name": "llm", **meta}}
    # Retrieval-only answer: quote the best evidence, each cited.
    sents = [{"text": f"{c.get('sender') or 'Evidence'}{(' on ' + fmt_date(c['refTs'])) if c.get('refTs') else ''}: “{quote(c.get('text', ''), 160)}”",
              "citations": [c["id"]], "supported": True} for c in ctx[:3]]
    return {"answer": "The most relevant evidence is: " + " ".join(s["text"] for s in sents), "sentences": sents,
            "generator": {"name": "retrieval", **meta}}
