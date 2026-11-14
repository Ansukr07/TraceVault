"""Evidence quality checks with related context from the shared case index."""
from __future__ import annotations

from typing import Any

from app.agents.common import AgentState, async_invoke, build_single_node_graph, chunks, citation_ids, evidence_items, sync_invoke, validate_case_ctx
from app.nlp.embeddings import embedder
from app.nlp.vector_store import vector_store


def _text(item: dict[str, Any]) -> str:
    return str(item.get("textEn") or item.get("text") or item.get("extractedText") or "").strip()


def _inspect(state: AgentState) -> AgentState:
    ctx = validate_case_ctx(state["caseCtx"])
    request = state.get("request", {})
    requested_id = str(request.get("evidenceId") or "").strip()
    evidence = evidence_items(ctx)
    available_chunks = chunks(ctx)
    evidence_by_id = {str(item.get("id") or item.get("evidenceId")): item for item in evidence if item.get("id") or item.get("evidenceId")}
    if requested_id:
        item = evidence_by_id.get(requested_id)
        if item is None:
            return {"result": {"caseId": ctx["caseId"], "evidenceId": requested_id, "status": "not_found_in_scope", "findings": [], "relatedEvidence": [], "citations": []}}
        targets = [item]
    else:
        targets = evidence

    chunk_by_id = {str(c.get("id") or c.get("chunkId")): c for c in available_chunks if c.get("id") or c.get("chunkId")}
    findings: list[dict[str, Any]] = []
    related: dict[str, dict[str, Any]] = {}
    citations: list[str] = []
    for item in targets:
        evidence_id = str(item.get("id") or item.get("evidenceId") or "unknown")
        kind = str(item.get("kind") or item.get("mimeType") or "unknown").lower()
        item_text = _text(item)
        item_citations = [evidence_id]
        item_chunk_ids = item.get("chunkIds") or item.get("chunk_ids") or []
        for chunk_id in item_chunk_ids:
            c = chunk_by_id.get(str(chunk_id))
            if c:
                item_text = (item_text + "\n" + _text(c)).strip()
                item_citations.append(str(c.get("id") or c.get("chunkId")))

        def add(code: str, priority: str, observation: str, next_step: str, confidence: str = "medium") -> None:
            findings.append({"evidenceId": evidence_id, "code": code, "priority": priority, "observation": observation, "suggestedNextStep": next_step, "confidence": confidence, "citations": item_citations})

        image_like = any(token in kind for token in ("image", "screenshot", "photo", "visual")) or str(item.get("mimeType", "")).startswith("image/")
        if image_like:
            width, height = item.get("width"), item.get("height")
            if width is not None and height is not None and (int(width) < 600 or int(height) < 400):
                add("LOW_IMAGE_RESOLUTION", "medium", f"Image dimensions are {width}×{height}; small text may be difficult to read.", "Capture or export the original at higher resolution if available.", "high")
            if not item_text:
                add("VISUAL_REVIEW_REQUIRED", "medium", "The supplied snapshot contains no extracted text or visual pixels to assess readability.", "Review the original image; if text is present, provide a clearer image or OCR result.", "high")
            elif len(item_text) < 30:
                add("LIMITED_VISUAL_CONTEXT", "low", "Only a small amount of text was extracted from this visual item.", "Check whether the screenshot includes the surrounding conversation, sender, and date where relevant.", "medium")
        if not item.get("capturedAt") and not item.get("createdAt") and not item.get("timestamp") and not item.get("date"):
            add("TIMESTAMP_MISSING", "low", "No capture or creation time is present in the supplied evidence metadata.", "Preserve the original file and note when and how it was obtained.", "high")
        if item.get("isCropped") is True or item.get("cropped") is True:
            add("CROPPED_CONTEXT", "medium", "The supplied metadata marks this item as cropped.", "Keep an unmodified original and include enough surrounding context to interpret the excerpt.", "high")
        if item.get("ocrConfidence") is not None:
            try:
                score = float(item["ocrConfidence"])
                if score < 0.6:
                    add("LOW_OCR_CONFIDENCE", "medium", f"OCR confidence is {score:.2f}; extracted text may contain recognition errors.", "Check the text against the original visual before relying on it.", "high")
            except (TypeError, ValueError):
                pass

        query = str(request.get("question") or item_text[:1200]).strip()
        if query:
            try:
                vector = embedder.encode([query])["embeddings"][0]
                hits = vector_store.query(str(ctx["caseId"]), vector, 5)
                for hit in hits:
                    hit_id = str(hit.get("chunkId") or "")
                    if not hit_id or hit_id in item_chunk_ids:
                        continue
                    chunk = chunk_by_id.get(hit_id)
                    if not chunk:
                        # Only return retrieved text after validating the ID in the caller's scoped snapshot.
                        continue
                    related[hit_id] = {"chunkId": hit_id, "text": _text(chunk), "evidenceId": chunk.get("evidenceId"), "distance": hit.get("distance"), "reason": "semantically related within this case"}
            except Exception as exc:
                related.setdefault(f"retrieval-warning:{evidence_id}", {"warning": f"Related evidence retrieval unavailable: {type(exc).__name__}"})
        citations.extend(item_citations)

    related_items = list(related.values())
    citations.extend(item["chunkId"] for item in related_items if "chunkId" in item)  # skip retrieval-warning entries
    return {"result": {"caseId": ctx["caseId"], "status": "reviewed", "reviewedEvidenceIds": [str(i.get("id") or i.get("evidenceId") or "unknown") for i in targets], "findings": findings, "relatedEvidence": related_items, "citations": list(dict.fromkeys(citations)), "method": "metadata_and_extraction_signals_plus_case_scoped_vector_retrieval", "limitations": ["Visual appearance and authenticity are not independently verified; review the original file."]}}


quality_graph = build_single_node_graph("evidence_quality", _inspect)


def sync_quality(case_ctx: dict[str, Any], evidence_id: str | None = None, question: str | None = None) -> dict[str, Any]:
    request = {"evidenceId": evidence_id, "question": question}
    return sync_invoke(quality_graph, {"caseCtx": case_ctx, "request": request})["result"]


async def async_quality(case_ctx: dict[str, Any], evidence_id: str | None = None, question: str | None = None) -> dict[str, Any]:
    request = {"evidenceId": evidence_id, "question": question}
    return (await async_invoke(quality_graph, {"caseCtx": case_ctx, "request": request}))["result"]
