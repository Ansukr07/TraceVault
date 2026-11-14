"""Objective planning and dynamic selection of read-only investigation graphs."""
from __future__ import annotations

from typing import Any

from app.agents.common import AgentState, async_invoke, build_single_node_graph, evidence_items, sync_invoke, validate_case_ctx

AGENT_PURPOSES = {
    "metadata_analysis": "Check metadata and timestamps for edited-file or time inconsistencies.",
    "financial_investigation": "Reconcile payments against bank and UPI records.",
    "evidence_gap": "Evaluate the evidence checklist for the incident types.",
    "rag_investigation": "Retrieve cited context relevant to an investigation question.",
    "knowledge_graph": "Connect people, accounts, evidence, events, and locations.",
    "investigation_replay": "Build a cited chronological account of timed events.",
    "report_generation": "Prepare a cited report draft and evidence index.",
    "evidence_quality": "Review evidence readability, context, and metadata; retrieve related case evidence.",
}

AVAILABLE_AGENTS = {"financial_investigation", "evidence_gap", "rag_investigation", "knowledge_graph", "investigation_replay", "report_generation", "evidence_quality"}


def _plan(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    objective = str(state.get("objective", "Review and organize this case evidence.")).strip()
    kinds = {str(item.get("kind", "")).lower() for item in evidence_items(ctx)}
    labels = set(ctx.get("incidentLabels", [])) | ({ctx.get("incidentType")} if ctx.get("incidentType") else set())
    objective_l = objective.lower()
    selected = {"knowledge_graph", "evidence_gap"}
    if evidence_items(ctx) or any(word in objective_l for word in ("quality", "readable", "screenshot", "image", "visual", "context", "evidence")):
        selected.add("evidence_quality")
    if ctx.get("statements") or labels & {"financial_fraud", "upi_bank_fraud", "scams"} or any(word in objective_l for word in ("payment", "bank", "upi", "financial", "fraud")):
        selected.add("financial_investigation")
    if ctx.get("question") or any(word in objective_l for word in ("who", "when", "what happened", "explain", "investigate")):
        selected.add("rag_investigation")
    selected.update({"investigation_replay", "report_generation"})
    order = ["metadata_analysis", "evidence_quality", "financial_investigation", "knowledge_graph", "evidence_gap", "rag_investigation", "investigation_replay", "report_generation"]
    selected.intersection_update(AVAILABLE_AGENTS)
    plan = [{"step": i + 1, "agent": name, "purpose": AGENT_PURPOSES[name], "dependsOn": []} for i, name in enumerate(name for name in order if name in selected)]
    return {"result": {"objective": objective, "plan": plan, "selectedAgents": [item["agent"] for item in plan], "evidenceKinds": sorted(kinds), "incidentLabels": sorted(label for label in labels if label), "mode": "read_only_case_snapshot"}}


plan_graph = build_single_node_graph("investigation_planning", _plan)


def sync_plan(case_ctx: dict[str, Any], objective: str) -> dict[str, Any]:
    return sync_invoke(plan_graph, {"caseCtx": case_ctx, "objective": objective})["result"]


async def async_plan(case_ctx: dict[str, Any], objective: str) -> dict[str, Any]:
    return (await async_invoke(plan_graph, {"caseCtx": case_ctx, "objective": objective}))["result"]
