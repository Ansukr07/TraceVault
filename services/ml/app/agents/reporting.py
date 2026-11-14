"""Cited report assembly and optional Sarvam Document AI statement extraction."""
from __future__ import annotations

import json
import os
import time
from typing import Any

import httpx

from app.agents.common import AgentState, build_single_node_graph, events, sync_invoke, validate_case_ctx

STATEMENT_SCHEMA = {"type": "object", "properties": {"account_holder": {"type": "string", "description": "Name of the bank account holder"}, "transactions": {"type": "array", "description": "Every transaction row in the statement", "items": {"type": "object", "properties": {"date": {"type": "string", "description": "Transaction date"}, "description": {"type": "string", "description": "Transaction description and counterparty"}, "amount": {"type": "number", "description": "Transaction amount, preserving debit or credit sign when shown"}, "upi_id": {"type": "string", "description": "UPI identifier if present"}, "reference": {"type": "string", "description": "Bank transaction or UTR reference"}}}}}}


def _report(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    sections = []
    for event in events(ctx):
        citations = event.get("evidenceChunkIds", [])
        validation = event.get("validation", {})
        support = validation.get("support")
        contradiction = validation.get("contradiction")
        supported = support is not None and float(support) >= 0.7 and not (contradiction is not None and float(contradiction) >= 0.85)
        flag = None if supported else ("contradicted" if contradiction is not None and float(contradiction) >= 0.85 else "support_not_validated")
        sections.append({"heading": event.get("title", "Event"), "sentences": [{"text": event.get("description") or event.get("title", ""), "citations": citations, "supported": supported, "supportScore": support, "contradictionScore": contradiction, "flag": flag if citations else "missing_citation"}]})
    evidence_index = [{key: item.get(key) for key in ("id", "sha256", "mime", "size")} for item in ctx.get("evidence", [])]
    return {"result": {"sections": sections, "evidenceIndex": evidence_index, "certificateDraft": {"status": "draft", "notice": "Draft to assist; complete and verify with the responsible person."}, "allSentencesValidatedOrFlagged": True, "regenerations": 0}}


report_graph = build_single_node_graph("report_generation", _report)


def sync_report(case_ctx: dict) -> dict:
    return sync_invoke(report_graph, {"caseCtx": case_ctx})["result"]


def extract_statement(document: bytes, filename: str, timeout_seconds: int = 180) -> dict[str, Any]:
    """Call Sarvam Extract's async job API for structured transaction rows."""
    key = os.getenv("SARVAM_API_KEY")
    if not key:
        raise RuntimeError("SARVAM_API_KEY is not configured")
    base, headers = os.getenv("SARVAM_DOC_AI_URL", "https://api.sarvam.ai/doc-ai/v1/job"), {"api-subscription-key": key}
    with httpx.Client(timeout=60) as client:
        response = client.post(f"{base}/extract", headers=headers, data={"schema": json.dumps(STATEMENT_SCHEMA), "output_format": "json", "model": os.getenv("SARVAM_EXTRACT_MODEL", "sarvam-vision-v1")}, files={"file": (filename, document, "application/pdf")})
        response.raise_for_status()
        job_id = response.json().get("job_id")
        if not job_id:
            raise RuntimeError("Sarvam Extract response did not include job_id")
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            response = client.get(f"{base}/{job_id}/status", headers=headers)
            response.raise_for_status()
            status = response.json()
            phase = str(status.get("status", "")).lower()
            if phase in {"completed", "partially_completed"}:
                result = client.get(f"{base}/{job_id}/results", headers=headers)
                result.raise_for_status()
                return result.json()
            if phase in {"failed", "rejected", "cancelled"}:
                raise RuntimeError(f"Sarvam Extract job {phase}: {status}")
            time.sleep(2)
    raise TimeoutError(f"Sarvam Extract job exceeded {timeout_seconds} seconds")
