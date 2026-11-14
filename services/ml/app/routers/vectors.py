from __future__ import annotations

import os

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.nlp.embeddings import embedder
from app.nlp.vector_store import vector_store

router = APIRouter(prefix="/vectors", tags=["vectors"])


class VectorQuery(BaseModel):
    caseId: str = Field(min_length=1)
    question: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=8, ge=1, le=50)


@router.post("/query")
def query_vectors(request: VectorQuery, x_internal_secret: str | None = Header(default=None)) -> dict:
    _authorize(x_internal_secret)
    try:
        # BGE-M3 is multilingual, so preserve the query language for cross-lingual search.
        query_embedding = embedder.encode([request.question])["embeddings"][0]
        hits = vector_store.query(request.caseId, query_embedding, request.limit)
        return {"caseId": request.caseId, "results": hits}
    except Exception as exc:
        raise HTTPException(503, f"Vector search unavailable: {exc}") from exc


@router.delete("/case/{case_id}")
def delete_case_vectors(case_id: str, x_internal_secret: str | None = Header(default=None)) -> dict:
    _authorize(x_internal_secret)
    try:
        return {"caseId": case_id, "deletedChunks": vector_store.delete_case(case_id)}
    except Exception as exc:
        raise HTTPException(503, f"Vector deletion unavailable: {exc}") from exc


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
