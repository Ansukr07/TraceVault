from __future__ import annotations

import os

from fastapi import APIRouter, Header, HTTPException

from app.nlp.ner import NLPModels
from app.nlp.temporal import extract_times
from app.nlp.embeddings import embedder
from app.ingestion.language import english_working_text
from app.routers.incident import classifier
from app.nlp.vector_store import vector_store
from app.schemas import EnrichRequest, EnrichResponse, Mention

router = APIRouter(prefix="/nlp", tags=["nlp"])
models = NLPModels()


@router.post("/enrich", response_model=EnrichResponse)
def enrich(request: EnrichRequest, x_internal_secret: str | None = Header(default=None)) -> EnrichResponse:
    _authorize(x_internal_secret)
    mentions = []
    times = []
    embeddings: dict[str, list[float]] = {}
    indexed_chunks = 0
    warnings = list(models.warnings)
    english_chunks: list[tuple[str, str]] = []
    working_texts: dict[str, str] = {}
    for chunk in request.chunks:
        text_en = chunk.textEn
        if text_en is None:
            try:
                text_en, _, translation_warnings = english_working_text(chunk.text, chunk.locale)
                warnings.extend(translation_warnings)
            except Exception as exc:
                warnings.append(f"Translation failed for chunk {chunk.id}: {exc}")
                text_en = chunk.text
        english_chunks.append((chunk.id, text_en))
        working_texts[chunk.id] = text_en
        for mention in models.extract(text_en, text_en):
            mentions.append(Mention(chunkId=chunk.id, text=mention.text, label=mention.label, start=mention.start, end=mention.end, confidence=mention.confidence, normalized=mention.normalized, source=mention.source))
        times.extend(extract_times(chunk.id, chunk.text, chunk.refTime, chunk.locale, request.timezone))
    incident_result = None
    if english_chunks:
        incident_text = "\n".join(text for _, text in english_chunks)
        entity_context = "; ".join(f"{m.label}: {m.text}" for m in mentions[:100])
        try:
            routed = classifier.classify(incident_text + (f"\nExtracted entities: {entity_context}" if entity_context else ""))
            incident_result = {"labels": routed.labels, "scores": routed.scores, "primary": routed.primary, "confidence": routed.confidence, "needsOwnerReview": routed.needs_owner_review, "provider": routed.provider, "warnings": routed.warnings}
        except Exception as exc:
            warnings.append(f"Incident routing failed: {exc}")
    if request.storeChunks and not request.caseId:
        warnings.append("caseId is required when storeChunks=true; chunks were not indexed")
    if request.includeEmbeddings or (request.storeChunks and request.caseId):
        try:
            encoded = embedder.encode([text for _, text in english_chunks])
            embeddings = {chunk_id: vector for (chunk_id, _), vector in zip(english_chunks, encoded["embeddings"])}
            if request.storeChunks:
                indexed_chunks = vector_store.upsert(str(request.caseId), [
                    {"chunkId": chunk.id, "textEn": text_en, "sourceText": chunk.text, "language": chunk.locale, "embedding": embeddings[chunk.id]}
                    for chunk, (chunk_id, text_en) in zip(request.chunks, english_chunks)
                ])
        except Exception as exc:
            warnings.append(f"Embedding or vector indexing failed: {exc}")
    if not request.includeEmbeddings:
        embeddings = {}
    return EnrichResponse(mentions=mentions, times=times, workingTexts=working_texts, embeddings=embeddings, indexedChunks=indexed_chunks, incident=incident_result, warnings=warnings)


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
