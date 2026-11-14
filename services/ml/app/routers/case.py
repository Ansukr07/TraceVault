"""Case-level routes (spec §10.2): /case/rebuild, /case/summarize, /case/ask."""
from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..case import dedup, events as ev, graph, inconsistency, insights, narrative, resolve, summarize
from ..case.common import norm_name

router = APIRouter()
GENERATOR_VERSION = 1


class RebuildIn(BaseModel):
    case: dict[str, Any] = {}
    ownerName: str | None = None
    evidence: list[dict[str, Any]]
    chunks: list[dict[str, Any]] = Field(max_length=50_000)
    constraints: dict[str, list[list[str]]] = {}
    eventOverrides: dict[str, dict[str, Any]] = {}


def rebuild_sync(body: RebuildIn) -> dict:
    chunks = body.chunks
    resolved = resolve.resolve(chunks, owner_name=body.ownerName, constraints=body.constraints)
    owner_key = next((e["key"] for e in resolved["entities"] if e.get("isOwner")), None)
    evidence_by_id = {e["id"]: e for e in body.evidence}
    dups = dedup.detect(body.evidence, chunks)
    raw_events = ev.extract(chunks, resolved, evidence_by_id, owner_key)
    merged = ev.merge(raw_events)
    timeline = ev.finalize(merged, body.eventOverrides)
    g = graph.build(chunks, body.evidence, resolved, timeline["events"])
    incs = inconsistency.detect(body.evidence, chunks, dups, resolved, timeline["events"])
    owner_names = {"me", "you"} | ({norm_name(body.ownerName)} if body.ownerName else set())
    ins = insights.build(chunks, owner_names)
    return {
        "entities": resolved["entities"], "mentions": resolved["mentions"], "candidates": resolved["candidates"],
        "duplicates": dups["groups"], "events": timeline["events"], "keyMoments": timeline["keyMoments"],
        "graph": g, "inconsistencies": incs, "insights": ins,
        "generator": {"name": "case_rebuild", "version": GENERATOR_VERSION},
    }


@router.post("/case/rebuild")
async def rebuild(body: RebuildIn):
    return await asyncio.to_thread(rebuild_sync, body)


class SummarizeIn(BaseModel):
    case: dict[str, Any] = {}
    llmMode: Literal["cloud", "cloud_redacted", "local"] = "cloud_redacted"
    evidence: list[dict[str, Any]]
    chunks: list[dict[str, Any]]
    entities: list[dict[str, Any]]
    events: list[dict[str, Any]]
    inconsistencies: list[dict[str, Any]] = []


def _pii(entities: list[dict]) -> dict[str, str]:
    out: dict[str, str] = {}
    for e in entities:
        if e["type"] == "PERSON":
            for a in e.get("aliases", []):
                if len(a) >= 3:
                    out[a] = "PERSON"
    return out


@router.post("/case/summarize")
async def summarize_route(body: SummarizeIn):
    chunks = {c["id"]: c for c in body.chunks}
    pii = _pii(body.entities)
    llm = await summarize.llm_summary(body.llmMode, body.case, chunks, body.events, body.inconsistencies, pii)
    if llm and sum(len(s["sentences"]) for s in llm["sections"]) >= 3:
        return llm
    out = summarize.template_summary(body.case, chunks, body.entities, body.events, body.inconsistencies, body.evidence)
    if llm is None:
        out["generator"]["note"] = "no LLM available for this privacy mode; deterministic summary"
    return out


class AskIn(BaseModel):
    question: str = Field(min_length=2, max_length=1000)
    llmMode: Literal["cloud", "cloud_redacted", "local"] = "cloud_redacted"
    chunks: list[dict[str, Any]]
    entities: list[dict[str, Any]] = []


@router.post("/case/ask")
async def ask(body: AskIn):
    return await summarize.answer(body.question, body.llmMode, {c["id"]: c for c in body.chunks}, _pii(body.entities))


class NarrativeIn(BaseModel):
    segments: list[dict[str, Any]] = Field(max_length=2000)
    lang: str | None = None
    llmMode: Literal["cloud", "cloud_redacted", "local"] = "cloud_redacted"
    refTs: str | None = None
    knownNames: list[str] = []


@router.post("/case/narrative")
async def narrative_route(body: NarrativeIn):
    pii = {n: "PERSON" for n in body.knownNames if len(n) >= 3}
    return await narrative.draft(body.segments, lang=body.lang, mode=body.llmMode, ref_ts=body.refTs, pii=pii)
