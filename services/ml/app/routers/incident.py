"""System1 incident-type extraction (Laya, multi-label) over the English working copy."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..models.system1 import system1 as classifier

router = APIRouter(prefix="/incident", tags=["incident"])


class IncidentRequest(BaseModel):
    textEn: str = Field(min_length=1, max_length=100_000)
    threshold: float | None = Field(default=None, ge=0, le=1)
    allowHosted: bool = True  # false keeps the text on this server (local Laya only)


class IncidentResponse(BaseModel):
    labels: list[str]
    scores: dict[str, float]
    primary: str
    confidence: float
    needsOwnerReview: bool
    provider: str
    warnings: list[str]


class ReviewRequest(BaseModel):
    caseCtx: dict[str, Any]
    results: dict[str, Any]
    plan: dict[str, Any] | None = None


@router.post("/classify", response_model=IncidentResponse)
async def classify_incident(request: IncidentRequest) -> IncidentResponse:
    try:
        result = await asyncio.to_thread(classifier.classify, request.textEn, request.threshold, request.allowHosted)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return IncidentResponse(**result.to_json())


@router.post("/review")
async def review_agents(request: ReviewRequest) -> dict[str, Any]:
    """System1 review of agent results the caller already holds (e.g. persisted /agents/run output)."""
    return await asyncio.to_thread(classifier.review, request.caseCtx, request.results, request.plan)
