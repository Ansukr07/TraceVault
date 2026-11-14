from __future__ import annotations

import asyncio
from typing import Any

from app.agents import evidence_quality, graph_analysis, investigation, orchestration, reporting
from app.agents.common import async_invoke
from app.agents.common import ScopeError
from app.models.system1 import system1

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


async def _run_one_async(name: str, case_ctx: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any]]:
    try:
        if name == "rag_investigation":
            out = await investigation.async_rag(case_ctx, str(case_ctx.get("question", "")))
        elif name == "evidence_quality":
            out = await evidence_quality.async_quality(case_ctx, case_ctx.get("evidenceId"), case_ctx.get("question"))
        elif name in ASYNC_AGENTS:
            out = await ASYNC_AGENTS[name](case_ctx)
        else:
            out = (await async_invoke(_GRAPHS[name], {"caseCtx": case_ctx}))["result"]
        return name, out, {"agent": name, "status": "completed"}
    except Exception as exc:
        return name, {"error": {"type": type(exc).__name__, "message": str(exc)}}, {"agent": name, "status": "failed", "error": type(exc).__name__}


async def run_agents_async(case_ctx: dict[str, Any], selected: list[str] | None = None, review: bool = False) -> dict[str, Any]:
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    names = selected if selected is not None else list(AGENTS)
    unknown = sorted(set(names) - set(AGENTS))
    if unknown:
        raise ValueError(f"Unknown agents: {', '.join(unknown)}")
    # Agents are read-only over the same snapshot and independent of each other, so they run concurrently.
    # Output and checkpoint order still follows the requested order.
    ran = await asyncio.gather(*(_run_one_async(name, case_ctx) for name in dict.fromkeys(names)))
    outputs = {name: out for name, out, _ in ran}
    checkpoints = [checkpoint for _, _, checkpoint in ran]
    response = {"caseId": case_ctx["caseId"], "results": outputs, "checkpoints": checkpoints, "status": "completed" if all(c["status"] == "completed" for c in checkpoints) else "partial", "persistence": "caller_persists_json"}
    if review:
        response["system1Review"] = await asyncio.to_thread(system1.review, case_ctx, outputs)
    return response


def run_investigation(case_ctx: dict[str, Any], objective: str) -> dict[str, Any]:
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    ctx, routed = with_system1_labels(case_ctx)
    plan = orchestration.sync_plan(ctx, objective)
    results = run_agents(ctx, plan["selectedAgents"])
    review = system1.review(ctx, results["results"], plan)
    return {"caseId": case_ctx["caseId"], "plan": plan, "results": results["results"], "system1": routed, "system1Review": review, "persistence": "caller_persists_json"}


async def run_investigation_async(case_ctx: dict[str, Any], objective: str) -> dict[str, Any]:
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    # System1 (open-source model layer) reads the snapshot before planning: when the caller supplied no
    # incident type, its calibrated labels steer the planner and the evidence-gap checklist.
    ctx, routed = await asyncio.to_thread(with_system1_labels, case_ctx)
    plan = await orchestration.async_plan(ctx, objective)
    results = await run_agents_async(ctx, plan["selectedAgents"])
    review = await asyncio.to_thread(system1.review, ctx, results["results"], plan)
    return {"caseId": case_ctx["caseId"], "plan": plan, "results": results["results"], "system1": routed, "system1Review": review, "persistence": "caller_persists_json"}


def with_system1_labels(case_ctx: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Shallow copy of caseCtx with System1 incident labels added when the caller gave none. Never overrides caller labels."""
    try:
        routed = system1.classify_case(case_ctx)
    except ValueError:
        routed = None
    if routed is None:
        return case_ctx, None
    if routed.labels and not case_ctx.get("incidentLabels") and not case_ctx.get("incidentType"):
        return {**case_ctx, "incidentLabels": list(routed.labels), "incidentLabelSource": "system1"}, routed.to_json()
    return case_ctx, routed.to_json()
