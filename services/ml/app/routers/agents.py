"""LangGraph investigation agents over a caller-supplied, scope-filtered case snapshot (read-only)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..agents.common import ScopeError
from ..agents.runner import AGENTS, run_agents_async, run_investigation_async

router = APIRouter(prefix="/agents", tags=["agents"])


class AgentRequest(BaseModel):
    caseCtx: dict[str, Any]
    agents: list[str] | None = None
    review: bool = True  # System1 cross-check of the agent outputs (advisory)


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


@router.get("")
def list_agents() -> dict[str, Any]:
    from ..agents.orchestration import AGENT_PURPOSES

    return {"agents": [{"name": name, "purpose": AGENT_PURPOSES.get(name)} for name in AGENTS]}


@router.post("/run")
async def run(request: AgentRequest) -> dict[str, Any]:
    try:
        return await run_agents_async(request.caseCtx, request.agents, review=request.review)
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/rag")
async def rag(request: RagRequest) -> dict[str, Any]:
    from ..agents.investigation import async_rag

    try:
        result = await async_rag(request.caseCtx, request.question)
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"caseId": request.caseCtx.get("caseId"), "result": result, "persistence": "caller_persists_json"}


@router.post("/evidence-quality")
async def evidence_quality(request: EvidenceQualityRequest) -> dict[str, Any]:
    from ..agents.evidence_quality import async_quality

    try:
        result = await async_quality(request.caseCtx, request.evidenceId, request.question)
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"caseId": request.caseCtx.get("caseId"), "result": result, "persistence": "caller_persists_json"}


@router.post("/investigate")
async def investigate(request: InvestigationRequest) -> dict[str, Any]:
    try:
        return await run_investigation_async(request.caseCtx, request.objective)
    except (ValueError, ScopeError) as exc:
        raise HTTPException(422, str(exc)) from exc
