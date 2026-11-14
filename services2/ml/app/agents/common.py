from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph


class AgentState(TypedDict, total=False):
    caseCtx: dict[str, Any]
    request: dict[str, Any]
    result: dict[str, Any]
    errors: list[str]
    tool_calls: int
    plan: list[dict[str, Any]]
    objective: str


class ScopeError(ValueError):
    pass


def validate_case_ctx(case_ctx: dict[str, Any]) -> dict[str, Any]:
    """Require an already scope-filtered snapshot; graph tools cannot access DB."""
    if not isinstance(case_ctx, dict) or not case_ctx.get("caseId") or not case_ctx.get("scopeFiltered"):
        raise ScopeError("caseCtx must include caseId and scopeFiltered=true")
    return case_ctx


def build_single_node_graph(name: str, node):
    graph = StateGraph(AgentState)
    graph.add_node(name, node)
    graph.add_edge(START, name)
    graph.add_edge(name, END)
    return graph.compile()


def sync_invoke(graph, state: AgentState) -> AgentState:
    """Required synchronous entry point for Node/worker integrations."""
    return graph.invoke(state)


async def async_invoke(graph, state: AgentState) -> AgentState:
    return await graph.ainvoke(state)


def evidence_items(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    return list(ctx.get("evidence", []))


def chunks(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    return list(ctx.get("chunks", []))


def entities(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    return list(ctx.get("entities", []))


def events(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    return list(ctx.get("events", []))


def citation_ids(items: list[dict[str, Any]]) -> list[str]:
    return list(dict.fromkeys(str(item.get("id") or item.get("chunkId")) for item in items if item.get("id") or item.get("chunkId")))
