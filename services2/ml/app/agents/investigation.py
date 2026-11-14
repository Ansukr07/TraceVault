"""Financial reconciliation, evidence gap checklists, and cited retrieval."""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from app.agents.common import AgentState, async_invoke, build_single_node_graph, chunks, citation_ids, events, sync_invoke, validate_case_ctx
from app.nlp.embeddings import embedder
from app.nlp.vector_store import vector_store

CHECKLISTS = {
    "harassment": ["dated communication or call record", "identity or account link for the alleged harasser", "preserved original media", "impact or safety context if the owner chooses to provide it"],
    "financial_fraud": ["transaction record", "communication describing the payment or request", "recipient account or UPI identifier", "bank or payment-provider complaint reference, if available"],
    "scams": ["offer or solicitation", "sender identity or account", "payment or credential request", "platform or report reference, if available"],
    "upi_bank_fraud": ["bank or UPI transaction record", "transaction identifier", "account or device alert", "bank complaint or dispute reference, if available"],
    "other": ["preserved original evidence", "relevant dates and participants recorded where available", "supporting context for the reported incident, if the owner chooses to provide it"],
}


def _number(value: Any) -> float | None:
    try:
        return float(str(value).replace("INR", "").replace("₹", "").replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _financial(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    payments = [e for e in events(ctx) if e.get("category") == "payment" or e.get("amount") is not None]
    rows = [row for statement in ctx.get("statements", []) for row in statement.get("transactions", [])]
    matched: set[int] = set()
    ledger, findings = [], []
    for event in payments:
        amount = _number(event.get("amount"))
        index = next((i for i, row in enumerate(rows) if i not in matched and amount is not None and _number(row.get("amount")) is not None and abs(amount - _number(row.get("amount"))) <= .01), None)
        if index is None:
            ledger.append({"eventId": event.get("id"), "amount": event.get("amount"), "matched": False, "citations": event.get("evidenceChunkIds", [])})
            continue
        matched.add(index)
        row = rows[index]
        ledger.append({"eventId": event.get("id"), "transaction": row, "matched": True, "citations": list(event.get("evidenceChunkIds", [])) + list(row.get("citations", []))})
    for row in rows:
        if row.get("claimedAmount") is not None and _number(row.get("claimedAmount")) != _number(row.get("amount")):
            findings.append({"code": "AMOUNT_MISMATCH", "statementRow": row, "citations": row.get("citations", [])})
    loss = sum(abs(_number(row.get("amount")) or 0) for row in rows if row.get("direction") == "debit" or (_number(row.get("amount")) or 0) < 0)
    upi: dict[str, int] = defaultdict(int)
    for row in rows:
        if row.get("upiId"):
            upi[str(row["upiId"]).lower()] += 1
    result = {"ledger": ledger, "findings": findings, "lossTotal": round(loss, 2), "currency": "INR", "muleCandidates": [{"upiId": key, "debitCount": count} for key, count in upi.items() if count >= 3], "unmatchedPaymentEventIds": [row["eventId"] for row in ledger if not row["matched"]]}
    return {"result": result}


def _gaps(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    labels = ctx.get("incidentLabels", []) or ([ctx.get("incidentType")] if ctx.get("incidentType") else [])
    text = " ".join(str(c.get("text", "")).lower() for c in chunks(ctx))
    markers = {word for word in ("transaction", "upi", "bank", "statement", "payment", "screenshot", "email", "phone", "call") if word in text}
    gaps = []
    for label in labels:
        for requirement in CHECKLISTS.get(label, []):
            terms = [word for word in requirement.lower().split() if len(word) > 5]
            covered = any(term in markers for term in terms) or (bool(events(ctx)) and "communication" in requirement)
            gaps.append({"incidentType": label, "what": requirement, "why": "May help organize the case record; this is not legal advice.", "linkedEntityOrEvent": None, "priority": "medium" if covered else "high", "status": "covered" if covered else "gap"})
    return {"result": {"gaps": gaps, "evaluatedIncidentTypes": labels, "checklistComplete": True}}


def _rag(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    question = str(state.get("request", {}).get("question", "")).strip()
    if not question:
        return {"result": {"answer": None, "abstained": True, "citations": [], "reason": "Question is required."}, "tool_calls": 0}
    all_chunks = chunks(ctx)
    retrieval_warning = None
    selected = []
    try:
        query_vector = embedder.encode([question])["embeddings"][0]
        hits = vector_store.query(str(ctx["caseId"]), query_vector, 8)
        chunks_by_id = {str(c.get("id") or c.get("chunkId")): c for c in all_chunks}
        selected = [chunks_by_id[hit["chunkId"]] for hit in hits if hit.get("chunkId") in chunks_by_id]
    except Exception as exc:
        retrieval_warning = f"Vector retrieval unavailable; used lexical retrieval: {exc}"
    if not selected:
        words = {word.lower().strip(".,?!") for word in question.split() if len(word) > 2}
        selected = [c for c in sorted(all_chunks, key=lambda c: sum(w in str(c.get("textEn") or c.get("text", "")).lower() for w in words), reverse=True) if any(w in str(c.get("textEn") or c.get("text", "")).lower() for w in words)][:8]
    if not selected:
        return {"result": {"answer": None, "abstained": True, "citations": [], "reason": "No matching evidence in scoped snapshot.", "warning": retrieval_warning}, "tool_calls": 1}
    citations = citation_ids(selected)
    return {"result": {"answer": None, "retrievalSnippets": [{"citation": c.get("id", c.get("chunkId")), "text": c.get("textEn") or c.get("text", "")} for c in selected], "abstained": True, "citations": citations, "validated": all(cid in {str(c.get("id") or c.get("chunkId")) for c in all_chunks} for cid in citations), "reason": "Retrieved cited context; no answer synthesis model is configured.", "warning": retrieval_warning}, "tool_calls": min(8, len(selected) + 1)}


financial_graph = build_single_node_graph("financial_investigation", _financial)
gap_graph = build_single_node_graph("evidence_gap", _gaps)
rag_graph = build_single_node_graph("rag_investigation", _rag)


def sync_financial(case_ctx: dict[str, Any]) -> dict[str, Any]:
    return sync_invoke(financial_graph, {"caseCtx": case_ctx})["result"]


def sync_gaps(case_ctx: dict[str, Any]) -> dict[str, Any]:
    return sync_invoke(gap_graph, {"caseCtx": case_ctx})["result"]


def sync_rag(case_ctx: dict[str, Any], question: str) -> dict[str, Any]:
    return sync_invoke(rag_graph, {"caseCtx": case_ctx, "request": {"question": question}})["result"]


async def async_rag(case_ctx: dict[str, Any], question: str) -> dict[str, Any]:
    return (await async_invoke(rag_graph, {"caseCtx": case_ctx, "request": {"question": question}}))["result"]
