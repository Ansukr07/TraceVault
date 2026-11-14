from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.agents.common import ScopeError
from app.agents.runner import run_agents_async, run_investigation_async

router = APIRouter(prefix="/agents", tags=["agents"])


class AgentRequest(BaseModel):
    caseCtx: dict[str, Any]
    agents: list[str] | None = None


class RagRequest(BaseModel):
    caseCtx: dict[str, Any]
    question: str = Field(min_length=1, max_length=4000)


class EvidenceQualityRequest(BaseModel):
    caseCtx: dict[str, Any]
    evidenceId: str | None = None
    question: str | None = Field(default=None, max_length=4000)


class InvestigationRequest(BaseModel):
    caseCtx: dict[str, Any]
    objective: str = Field(min_length=1, max_length=4000)


@router.post("/run")
async def run(request: AgentRequest, x_internal_secret: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_internal_secret)
    try:
        return await run_agents_async(request.caseCtx, request.agents)
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/rag")
async def rag(request: RagRequest, x_internal_secret: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_internal_secret)
    try:
        from app.agents.investigation import async_rag
        result = await async_rag(request.caseCtx, request.question)
        return {"caseId": request.caseCtx.get("caseId"), "result": result, "persistence": "caller_persists_json"}
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/evidence-quality")
async def evidence_quality(request: EvidenceQualityRequest, x_internal_secret: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_internal_secret)
    try:
        from app.agents.evidence_quality import async_quality
        result = await async_quality(request.caseCtx, request.evidenceId, request.question)
        return {"caseId": request.caseCtx.get("caseId"), "result": result, "persistence": "caller_persists_json"}
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/investigate")
async def investigate(request: InvestigationRequest, x_internal_secret: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_internal_secret)
    try:
        return await run_investigation_async(request.caseCtx, request.objective)
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
