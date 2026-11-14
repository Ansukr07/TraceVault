"""Knowledge graph assembly and relationship analysis over caseCtx."""
from __future__ import annotations

from app.agents.common import AgentState, async_invoke, build_single_node_graph, chunks, entities, events, sync_invoke, validate_case_ctx


def _construct(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    nodes, edges = [], []
    for entity in entities(ctx):
        nodes.append({"id": str(entity.get("id")), "type": entity.get("type", "Person"), "label": entity.get("name") or entity.get("normalized"), "citations": entity.get("citations", [])})
    for item in ctx.get("evidence", []):
        nodes.append({"id": str(item.get("id")), "type": "Evidence", "label": item.get("filename"), "citations": [item.get("id")]})
    for event in events(ctx):
        event_id, citations = str(event.get("id")), event.get("evidenceChunkIds", [])
        nodes.append({"id": event_id, "type": "Event", "label": event.get("title"), "citations": citations})
        edges.extend({"source": str(entity_id), "target": event_id, "type": "PARTICIPATES_IN", "citations": citations} for entity_id in event.get("entityIds", []))
    known_chunks = {str(c.get("id") or c.get("chunkId")) for c in chunks(ctx)}
    valid = all(str(cid) in known_chunks or any(n["id"] == str(cid) and n["type"] == "Evidence" for n in nodes) for edge in edges for cid in edge["citations"])
    # Cross-modal corroboration links only explicitly matched chunk/evidence IDs.
    evidence_for_chunk = {str(chunk.get("id") or chunk.get("chunkId")): str(chunk.get("evidenceId")) for chunk in chunks(ctx) if chunk.get("evidenceId")}
    seen_pairs: set[tuple[str, str]] = set()
    for match in ctx.get("crossModalMatches", []):
        left, right = str(match.get("leftChunkId")), str(match.get("rightChunkId"))
        pair = tuple(sorted((left, right)))
        if pair in seen_pairs or left not in evidence_for_chunk or right not in evidence_for_chunk:
            continue
        seen_pairs.add(pair)
        support = match.get("support")
        contradiction = match.get("contradiction")
        edges.append({"source": evidence_for_chunk[left], "target": evidence_for_chunk[right], "type": "CROSS_MODAL_MATCH", "confidence": match.get("confidence"), "citations": [left, right], "support": support, "contradiction": contradiction, "status": "contradicted" if contradiction is not None and float(contradiction) >= .85 else "supported" if support is not None and float(support) >= .7 else "unvalidated"})
    return {"result": {"schemaVersion": "1", "nodes": nodes, "edges": edges, "unplacedEntityIds": [], "unplacedEventIds": [], "citationsValid": valid, "crossModalMatchCount": len(seen_pairs)}}


def _relationships(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    people = [e for e in entities(ctx) if e.get("type", "Person") in {"Person", "Account"}]
    pairs = []
    for i, left in enumerate(people):
        for right in people[i + 1:]:
            shared = set(left.get("chunkIds", [])) & set(right.get("chunkIds", []))
            if shared:
                pairs.append({"entityIds": [left.get("id"), right.get("id")], "sharedChunkIds": sorted(shared), "status": "candidate", "confidence": 0.5})
    degree = {e.get("id"): 0 for e in people}
    for event in events(ctx):
        for entity_id in event.get("entityIds", []):
            if entity_id in degree:
                degree[entity_id] += 1
    central = sorted(({"entityId": key, "eventDegree": val} for key, val in degree.items()), key=lambda x: x["eventDegree"], reverse=True)
    return {"result": {"samePersonCandidates": pairs, "centralFigures": central, "firstContact": min((e for e in events(ctx) if e.get("timestamp")), key=lambda e: e["timestamp"], default=None), "communities": [], "adjudicatedCandidateCount": len(pairs)}}


def _replay(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    replay = []
    for event in events(ctx):
        timestamp = event.get("timestamp") or event.get("timeStart")
        if not timestamp:
            continue
        replay.append({"id": event.get("id"), "timestamp": timestamp, "rangeEnd": event.get("timeEnd"), "title": event.get("title"), "description": event.get("description"), "actors": event.get("entityIds", []), "sourceIds": event.get("evidenceChunkIds", []), "modalities": event.get("modalities", []), "supportingSources": event.get("supportingSources", []), "contradictingSources": event.get("contradictingSources", []), "supportScore": event.get("validation", {}).get("support"), "contradictionScore": event.get("validation", {}).get("contradiction"), "severity": event.get("severity"), "confidence": event.get("confidence")})
    replay.sort(key=lambda item: (str(item["timestamp"]), str(item.get("id", ""))))
    return {"result": {"caseId": ctx["caseId"], "items": replay, "untimedEventIds": [e.get("id") for e in events(ctx) if not e.get("timestamp") and not e.get("timeStart")]}}


def _knowledge_graph(state: AgentState) -> AgentState:
    """Build the case graph and its relationship analysis in one agent run."""
    constructed = _construct(state)["result"]
    relationships = _relationships(state)["result"]
    return {"result": {**constructed, **relationships}}


knowledge_graph = build_single_node_graph("knowledge_graph", _knowledge_graph)
replay_graph = build_single_node_graph("investigation_replay", _replay)


def sync_construction(case_ctx: dict) -> dict:
    return sync_invoke(knowledge_graph, {"caseCtx": case_ctx})["result"]


async def async_knowledge_graph(case_ctx: dict) -> dict:
    return (await async_invoke(knowledge_graph, {"caseCtx": case_ctx}))["result"]


def sync_replay(case_ctx: dict) -> dict:
    return sync_invoke(replay_graph, {"caseCtx": case_ctx})["result"]


async def async_replay(case_ctx: dict) -> dict:
    return (await async_invoke(replay_graph, {"caseCtx": case_ctx}))["result"]
