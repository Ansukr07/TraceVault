"""POST /extract (per-evidence extraction) and POST /nlp/enrich (spec §7)."""
from __future__ import annotations

import asyncio
import re
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..lang.translate import annotate_chunks
from ..nlp import ner, severity
from ..parsers import extract as ex
from ..voice import audio
from ..voice.sarvam_client import UsageLog, get_client
from ..voice.transcribe import transcribe

router = APIRouter()

# WhatsApp media names carry the send date: IMG-20240512-WA0001.jpg, PTT-20240512-WA0003.opus,
# "WhatsApp Image 2024-05-12 at 21.41.23.jpeg", "WhatsApp Ptt 2024-05-12 at 9.41.23 PM.ogg".
_WA_NAME = [
    re.compile(r"(?:IMG|PTT|AUD|VID|DOC|STK)-(\d{4})(\d{2})(\d{2})-WA\d+", re.IGNORECASE),
    re.compile(r"WhatsApp \w+ (\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})(?:\s?([AP]M))?", re.IGNORECASE),
]


def filename_ts(name: str) -> tuple[str | None, str]:
    for pat in _WA_NAME:
        m = pat.search(name or "")
        if m:
            g = m.groups()
            y, mo, d = g[0], g[1], g[2]
            if len(g) > 3 and g[3]:
                h = int(g[3])
                if g[6]:
                    h = h % 12 + (12 if g[6].upper() == "PM" else 0)
                return f"{y}-{mo}-{d}T{h:02d}:{g[4]}:{g[5]}", "exact"
            return f"{y}-{mo}-{d}T00:00:00", "day"
    return None, "none"


def _fail(code: str, msg: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": msg})


@router.post("/extract")
async def extract_route(
    file: UploadFile = File(...),
    kind: Literal["chat_export", "image", "audio", "statement", "pdf", "email", "archive"] = Form(...),
    filename: str = Form(""),
    voiceProvider: Literal["sarvam", "local"] = Form("local"),
    translateMode: Literal["sarvam", "sarvam_redacted", "off"] = Form("off"),
    referenceTs: str | None = Form(None),
):
    data = await file.read()
    usage = UsageLog()
    name_ts, name_prec = filename_ts(filename)
    try:
        if kind == "chat_export":
            out = await asyncio.to_thread(ex.extract_chat, data)
        elif kind == "image":
            out = await asyncio.to_thread(ex.extract_image, data, name_ts or referenceTs)
        elif kind == "pdf":
            out = await asyncio.to_thread(ex.extract_pdf, data)
        elif kind == "email":
            out = await asyncio.to_thread(ex.extract_email, data)
        elif kind == "archive":
            out = await asyncio.to_thread(ex.extract_archive, data)
        else:  # audio / statement
            tr = await transcribe(data, provider=voiceProvider, client=get_client())
            usage.records.extend(tr.pop("usage"))
            base = name_ts
            chunks = []
            for s in tr["segments"]:
                chunks.append({
                    "idx": len(chunks), "text": s["text"], "textEn": s.get("textEn"), "lang": s.get("lang"),
                    "langConfidence": s.get("langConfidence"), "unit": "segment", "speaker": s.get("speaker"),
                    "refTs": base, "failed": bool(s.get("failed")),
                    "locator": {"startMs": s["startMs"], "endMs": s["endMs"]},
                })
            out = {"artifactType": "transcript", "artifact": tr, "chunks": chunks,
                   "metadata": {"durationMs": tr["durationMs"], "lang": tr["lang"], "provider": tr["provider"]},
                   "flags": [], "children": []}
            if tr.get("fallback"):
                out["fallback"] = tr["fallback"]
    except audio.AudioError as e:
        raise _fail("AUDIO_DECODE_FAILED", str(e))
    except Exception as e:  # noqa: BLE001  — corrupt files must fail the step, not the service
        raise _fail("EXTRACT_FAILED", f"{type(e).__name__}: {e}"[:300])

    # Chunks with no time of their own fall back to the file-name time, then the upload time (spec N2 priority).
    for c in out["chunks"]:
        if not c.get("refTs"):
            c["refTs"] = name_ts or out["metadata"].get("captureTime") or out["metadata"].get("sentAt")
            c["refTsSource"] = "filename" if name_ts else ("exif" if out["metadata"].get("captureTime") else "none")
    if name_ts:
        out["metadata"]["filenameTs"] = name_ts
        out["metadata"]["filenameTsPrecision"] = name_prec

    await annotate_chunks([c for c in out["chunks"] if c.get("text") and not c.get("failed")],
                          client=get_client(), mode=translateMode, usage=usage)
    out["usage"] = usage.records
    out["generator"] = {"name": f"extract_{kind}", "version": ex.GENERATOR_VERSION}
    return out


class EnrichChunk(BaseModel):
    id: str
    text: str
    textEn: str | None = None
    refTs: str | None = None
    sender: str | None = None


class EnrichIn(BaseModel):
    chunks: list[EnrichChunk] = Field(max_length=20_000)
    knownNames: list[str] = []


@router.post("/nlp/enrich")
async def enrich(body: EnrichIn):
    names = set(body.knownNames) | {c.sender for c in body.chunks if c.sender}

    def work():
        out = []
        for c in body.chunks:
            ents = ner.extract(c.text, known_names=names, ref_ts=c.refTs, text_en=c.textEn)
            sev = severity.classify(c.text, c.textEn)
            times = [{"text": e["text"], "start": e["start"], "end": e["end"], "ts": e["norm"], "precision": e.get("precision", "day")}
                     for e in ents if e["type"] in ("DATE", "TIME")]
            out.append({"id": c.id, "entities": ents, "times": times, "severity": sev})
        return out

    return {"items": await asyncio.to_thread(work), "generator": {"name": "nlp_rules", "version": 1,
                                                                   "spacy": ner.spacy_available()}}
