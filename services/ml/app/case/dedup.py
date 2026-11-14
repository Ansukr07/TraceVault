"""Duplicate detection (spec N4): exact, near-image, near-text and cross-modal.

Duplicates are grouped, never deleted. A cross-modal pair that matches but carries
different numbers (₹5,000 vs ₹50,000) or a different date is NOT a duplicate: it is
returned as a contradiction for the inconsistency detector.
"""
from __future__ import annotations

import re
from itertools import combinations

from rapidfuzz import fuzz

from .common import parse_ts, stable_key

PHASH_MAX = 8
DHASH_MAX = 10
MINHASH_JACCARD = 0.8
EDIT_SIM = 0.85
SEMANTIC_SIM = 0.9
CROSS_MODAL_WINDOW_S = 120
_NUM = re.compile(r"\d[\d,]*")


def _hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s₹]", " ", (t or "").lower())).strip()


def _nums(t: str) -> set[str]:
    return {n.replace(",", "") for n in _NUM.findall(t or "")}


def _minhash(text: str):
    from datasketch import MinHash

    m = MinHash(num_perm=128)
    words = _norm(text).split()
    for i in range(max(1, len(words) - 2)):
        m.update(" ".join(words[i:i + 3]).encode())
    return m


def detect(evidence: list[dict], chunks: list[dict]) -> dict:
    groups: list[dict] = []
    contradictions: list[dict] = []

    # exact (same SHA-256)
    by_sha: dict[str, list[dict]] = {}
    for e in evidence:
        by_sha.setdefault(e["sha256"], []).append(e)
    for sha, es in by_sha.items():
        if len(es) > 1:
            es.sort(key=lambda e: e["idx"])
            groups.append({"kind": "exact", "score": 1.0, "canonical": es[0]["id"],
                           "members": [{"evidenceId": e["id"]} for e in es]})

    # near-image (perceptual hashes)
    imgs = [e for e in evidence if e.get("hashes", {}).get("phash")]
    for a, b in combinations(imgs, 2):
        if a["sha256"] == b["sha256"]:
            continue
        ph = _hamming(a["hashes"]["phash"], b["hashes"]["phash"])
        dh = _hamming(a["hashes"]["dhash"], b["hashes"]["dhash"])
        if ph <= PHASH_MAX and dh <= DHASH_MAX:
            first, second = sorted((a, b), key=lambda e: e["idx"])
            groups.append({"kind": "near_image", "score": round(1 - ph / 64, 3), "canonical": first["id"],
                           "members": [{"evidenceId": first["id"]}, {"evidenceId": second["id"]}], "detail": {"phash": ph, "dhash": dh}})

    # near-text (whole-document MinHash)
    text_by_ev: dict[str, str] = {}
    for c in chunks:
        text_by_ev[c["evidenceId"]] = text_by_ev.get(c["evidenceId"], "") + " " + (c.get("text") or "")
    docs = [(e, text_by_ev.get(e["id"], "")) for e in evidence if len(text_by_ev.get(e["id"], "").split()) >= 8]
    hashes = {e["id"]: _minhash(t) for e, t in docs}
    for (a, _), (b, _) in combinations(docs, 2):
        if a["sha256"] == b["sha256"]:
            continue
        j = hashes[a["id"]].jaccard(hashes[b["id"]])
        if j >= MINHASH_JACCARD:
            first, second = sorted((a, b), key=lambda e: e["idx"])
            groups.append({"kind": "near_text", "score": round(j, 3), "canonical": first["id"],
                           "members": [{"evidenceId": first["id"]}, {"evidenceId": second["id"]}]})

    # cross-modal (chunk level): screenshot bubbles/OCR blocks vs chat messages / paragraphs / segments
    visual = [c for c in chunks if c.get("unit") in ("bubble", "ocr_block") and len(_norm(c.get("text"))) >= 6]
    others = [c for c in chunks if c.get("unit") not in ("bubble", "ocr_block") and len(_norm(c.get("text"))) >= 6]
    for v in visual:
        nv = _norm(v["text"])
        best = None
        for o in others:
            if o["evidenceId"] == v["evidenceId"]:
                continue
            no = _norm(o["text"])
            # token_set_ratio is 100% when one side's words are a subset of the other's, so a lone
            # greeting ("Ananya,") "matches" any long message that names her. Require real overlap.
            if min(len(nv.split()), len(no.split())) < 3:
                continue
            sem = fuzz.token_set_ratio(nv, no) / 100
            if sem < SEMANTIC_SIM:
                continue
            edit = fuzz.ratio(nv, no) / 100
            if best is None or (sem, edit) > (best[1], best[2]):
                best = (o, sem, edit)
        if not best:
            continue
        o, sem, edit = best
        tv, to = parse_ts(v.get("refTs")), parse_ts(o.get("refTs"))
        gap = abs((tv - to).total_seconds()) if tv and to else None
        # Screenshots often only show a time of day: compare that when the date is unknown.
        if gap is None and v.get("timeOfDay") and to:
            hv, mv = map(int, v["timeOfDay"].split(":"))
            gap = abs((hv * 60 + mv) - (to.hour * 60 + to.minute)) * 60
        nums_differ = _nums(v["text"]) != _nums(o["text"]) and bool(_nums(v["text"]) | _nums(o["text"]))
        pair = {"visualChunkId": v["id"], "otherChunkId": o["id"], "visualEvidenceId": v["evidenceId"],
                "otherEvidenceId": o["evidenceId"], "semantic": round(sem, 3), "edit": round(edit, 3), "gapS": gap}
        if nums_differ or edit < EDIT_SIM:
            contradictions.append({**pair, "kind": "content", "numbersDiffer": nums_differ})
        elif gap is not None and gap > 86400:
            contradictions.append({**pair, "kind": "date"})
        elif gap is None or gap <= CROSS_MODAL_WINDOW_S:
            groups.append({"kind": "cross_modal", "score": round(edit, 3), "canonical": o["evidenceId"],
                           "members": [{"evidenceId": o["evidenceId"], "chunkId": o["id"]},
                                       {"evidenceId": v["evidenceId"], "chunkId": v["id"]}],
                           "detail": {"gapS": gap}})

    for g in groups:
        g["key"] = stable_key(g["kind"], *sorted(f"{m['evidenceId']}/{m.get('chunkId', '')}" for m in g["members"]))
    return {"groups": groups, "contradictions": contradictions}
