from __future__ import annotations

import os

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.incident import IncidentRouter

router = APIRouter(prefix="/incident", tags=["incident"])
classifier = IncidentRouter()


class IncidentRequest(BaseModel):
    textEn: str = Field(min_length=1, max_length=100_000)
    threshold: float | None = Field(default=None, ge=0, le=1)


class IncidentResponse(BaseModel):
    labels: list[str]
    scores: dict[str, float]
    primary: str
    confidence: float
    needsOwnerReview: bool
    provider: str
    warnings: list[str]


@router.post("/classify", response_model=IncidentResponse)
def classify_incident(request: IncidentRequest, x_internal_secret: str | None = Header(default=None)) -> IncidentResponse:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and x_internal_secret != expected:
        raise HTTPException(401, "Invalid internal service credential")
    try:
        result = classifier.classify(request.textEn, request.threshold)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return IncidentResponse(labels=result.labels, scores=result.scores, primary=result.primary, confidence=result.confidence, needsOwnerReview=result.needs_owner_review, provider=result.provider, warnings=result.warnings)
