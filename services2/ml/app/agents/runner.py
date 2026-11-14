from __future__ import annotations

from typing import Any

from app.agents import evidence_quality, graph_analysis, investigation, orchestration, reporting
from app.agents.common import async_invoke
from app.agents.common import ScopeError

_GRAPHS = {
    "financial_investigation": investigation.financial_graph,
    "evidence_gap": investigation.gap_graph,
    "knowledge_graph": graph_analysis.knowledge_graph,
    "investigation_replay": graph_analysis.replay_graph,
    "report_generation": reporting.report_graph,
    "evidence_quality": evidence_quality.quality_graph,
}

AGENTS = {
    "financial_investigation": investigation.sync_financial,
    "evidence_gap": investigation.sync_gaps,
    "rag_investigation": None,
    "knowledge_graph": graph_analysis.sync_construction,
    "investigation_replay": graph_analysis.sync_replay,
    "report_generation": reporting.sync_report,
    "evidence_quality": None,
}

ASYNC_AGENTS = {
    "knowledge_graph": graph_analysis.async_knowledge_graph,
    "investigation_replay": graph_analysis.async_replay,
    "evidence_quality": None,
}


def run_agents(case_ctx: dict[str, Any], selected: list[str] | None = None) -> dict[str, Any]:
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    names = selected if selected is not None else list(AGENTS)
    unknown = sorted(set(names) - set(AGENTS))
    if unknown:
        raise ValueError(f"Unknown agents: {', '.join(unknown)}")
    outputs, checkpoints = {}, []
    for name in names:
        try:
            if name == "rag_investigation":
                outputs[name] = investigation.sync_rag(case_ctx, str(case_ctx.get("question", "")))
            elif name == "evidence_quality":
                outputs[name] = evidence_quality.sync_quality(case_ctx, case_ctx.get("evidenceId"), case_ctx.get("question"))
            else:
                outputs[name] = AGENTS[name](case_ctx)
            checkpoints.append({"agent": name, "status": "completed"})
        except Exception as exc:
            outputs[name] = {"error": {"type": type(exc).__name__, "message": str(exc)}}
            checkpoints.append({"agent": name, "status": "failed", "error": type(exc).__name__})
    return {"caseId": case_ctx["caseId"], "results": outputs, "checkpoints": checkpoints, "status": "completed" if all(c["status"] == "completed" for c in checkpoints) else "partial", "persistence": "caller_persists_json"}


async def run_agents_async(case_ctx: dict[str, Any], selected: list[str] | None = None) -> dict[str, Any]:
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    names = selected if selected is not None else list(AGENTS)
    unknown = sorted(set(names) - set(AGENTS))
    if unknown:
        raise ValueError(f"Unknown agents: {', '.join(unknown)}")
    outputs, checkpoints = {}, []
    for name in names:
        try:
            if name == "rag_investigation":
                outputs[name] = await investigation.async_rag(case_ctx, str(case_ctx.get("question", "")))
            elif name == "evidence_quality":
                outputs[name] = await evidence_quality.async_quality(case_ctx, case_ctx.get("evidenceId"), case_ctx.get("question"))
            elif name in ASYNC_AGENTS:
                outputs[name] = await ASYNC_AGENTS[name](case_ctx)
            else:
                outputs[name] = (await async_invoke(_GRAPHS[name], {"caseCtx": case_ctx}))["result"]
            checkpoints.append({"agent": name, "status": "completed"})
        except Exception as exc:
            outputs[name] = {"error": {"type": type(exc).__name__, "message": str(exc)}}
            checkpoints.append({"agent": name, "status": "failed", "error": type(exc).__name__})
    return {"caseId": case_ctx["caseId"], "results": outputs, "checkpoints": checkpoints, "status": "completed" if all(c["status"] == "completed" for c in checkpoints) else "partial", "persistence": "caller_persists_json"}


def run_investigation(case_ctx: dict[str, Any], objective: str) -> dict[str, Any]:
    plan = orchestration.sync_plan(case_ctx, objective)
    results = run_agents(case_ctx, plan["selectedAgents"])
    return {"caseId": case_ctx["caseId"], "plan": plan, "results": results["results"], "persistence": "caller_persists_json"}


async def run_investigation_async(case_ctx: dict[str, Any], objective: str) -> dict[str, Any]:
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    plan = await orchestration.async_plan(case_ctx, objective)
    results = await run_agents_async(case_ctx, plan["selectedAgents"])
    return {"caseId": case_ctx["caseId"], "plan": plan, "results": results["results"], "persistence": "caller_persists_json"}
