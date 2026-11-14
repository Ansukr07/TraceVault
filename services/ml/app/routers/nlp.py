"""POST /nlp/enrich — chunk-level NLP: NER + time normalisation + severity, optional BGE-M3 embeddings and
case-scoped Chroma indexing, and System1 incident routing.

One endpoint, two response views, so existing callers keep working:
  * `items[]`   — per-chunk {id, entities, times, severity} (Node pipeline contract)
  * `mentions`, `times`, `workingTexts`, `embeddings`, `indexedChunks`, `incident`, `warnings` (services2 contract)

Privacy: nothing leaves the machine unless the caller asks. Translation runs only with `translate=true`
(the Node pipeline already applies the case's translateMode in /extract); embeddings run locally; System1
sends text to the hosted model (HF_TOKEN) only with `classifyIncident=true`.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..ingestion.language import english_working_text
from ..models.system1 import system1
from ..nlp import ner, severity
from ..nlp.embeddings import embedder
from ..nlp.vector_store import vector_store

router = APIRouter(tags=["nlp"])
_PRECISION = {"exact": "exact", "minute": "exact", "day": "approx", "approx": "approx", "month": "approx", "range": "approx"}


class EnrichChunk(BaseModel):
    id: str
    text: str
    textEn: str | None = None
    refTs: str | None = None
    refTime: str | None = None  # services2 name for refTs
    sender: str | None = None
    locale: str | None = None


class EnrichIn(BaseModel):
    chunks: list[EnrichChunk] = Field(max_length=20_000)
    knownNames: list[str] = []
    caseId: str | None = None
    timezone: str = "Asia/Kolkata"
    translate: bool = False
    includeEmbeddings: bool = False
    storeChunks: bool | None = None  # default: index when caseId is given
    classifyIncident: bool | None = None  # default: only when System1 runs locally (no HF_TOKEN)


def _work(body: EnrichIn) -> dict[str, Any]:
    names = set(body.knownNames) | {c.sender for c in body.chunks if c.sender}
    warnings: list[str] = []
    items, mentions, times = [], [], []
    working: dict[str, str] = {}
    for c in body.chunks:
        text_en = c.textEn
        if text_en is None and body.translate:
            try:
                text_en, _, extra = english_working_text(c.text, c.locale)
                warnings.extend(extra)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Translation failed for chunk {c.id}: {exc}")
        working[c.id] = text_en or c.text
        ents = ner.extract(c.text, known_names=names, ref_ts=c.refTs or c.refTime, text_en=text_en)
        sev = severity.classify(c.text, text_en)
        chunk_times = [{"text": e["text"], "start": e["start"], "end": e["end"], "ts": e["norm"], "precision": e.get("precision", "day")}
                       for e in ents if e["type"] in ("DATE", "TIME")]
        items.append({"id": c.id, "entities": ents, "times": chunk_times, "severity": sev})
        for e in ents:
            if e["type"] in ("DATE", "TIME"):
                times.append({"chunkId": c.id, "expression": e["text"], "start": e["start"], "end": e["end"], "iso": e.get("norm"),
                              "rangeEnd": e.get("rangeEnd"), "tsPrecision": _PRECISION.get(e.get("precision", "day"), "unknown"),
                              "timezone": body.timezone})
            else:
                mentions.append({"chunkId": c.id, "text": e["text"], "label": e["type"], "start": e["start"], "end": e["end"],
                                 "confidence": float(e.get("conf", 0.95 if e.get("source", "regex") == "regex" else 0.75)),
                                 "normalized": None if e.get("norm") is None else str(e["norm"]), "source": e.get("source", "rules")})

    incident = None
    run_system1 = body.classifyIncident if body.classifyIncident is not None else not os.getenv("HF_TOKEN")
    if run_system1 and working:
        text = "\n".join(working.values())
        context = "; ".join(f"{m['label']}: {m['text']}" for m in mentions[:100])
        try:
            incident = system1.classify(text + (f"\nExtracted entities: {context}" if context else "")).to_json()
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"System1 incident routing failed: {exc}")

    store = body.storeChunks if body.storeChunks is not None else bool(body.caseId)
    if store and not body.caseId:
        warnings.append("caseId is required when storeChunks=true; chunks were not indexed")
        store = False
    embeddings: dict[str, list[float]] = {}
    indexed = 0
    if body.includeEmbeddings or store:
        try:
            ids = list(working)
            vectors = embedder.encode([working[i] for i in ids])["embeddings"]
            embeddings = dict(zip(ids, vectors))
            if store:
                by_id = {c.id: c for c in body.chunks}
                indexed = vector_store.upsert(str(body.caseId), [
                    {"chunkId": i, "textEn": working[i], "sourceText": by_id[i].text, "language": by_id[i].locale, "embedding": embeddings[i]}
                    for i in ids])
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Embedding or vector indexing failed: {exc}")

    return {"items": items, "mentions": mentions, "times": times, "workingTexts": working,
            "embeddings": embeddings if body.includeEmbeddings else {}, "indexedChunks": indexed, "incident": incident,
            "warnings": list(dict.fromkeys(warnings)),
            "generator": {"name": "nlp_rules", "version": 1, "spacy": ner.spacy_available(), "system1": system1.model_name}}


@router.post("/nlp/enrich")
async def enrich(body: EnrichIn):
    return await asyncio.to_thread(_work, body)
