"""Voice + language routes of the internal ML API (spec §10.2).

Every response that touched a provider carries `usage` (metering records, no content)
so the Node API can persist them in `providerUsage`.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..lang import detect as lid
from ..lang.redact import redact, restore
from ..voice import audio
from ..voice.sarvam_client import SarvamError, SarvamUnavailable, UsageLog, get_client
from ..voice.transcribe import transcribe

router = APIRouter()

MAX_QUERY_MS = 30_000
TTS_CHUNK_CHARS = 2_500


def _bad(code: str, msg: str, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": msg})


# ------------------------------------------------------------------ STT
@router.post("/transcribe")
async def transcribe_route(
    file: UploadFile = File(...),
    provider: Literal["sarvam", "local"] = Form("sarvam"),
    diarize: bool = Form(False),
    numSpeakers: int | None = Form(None),
    segments: str | None = Form(None, description='JSON [[startMs,endMs],...] to (re)transcribe only these'),
):
    data = await file.read()
    only = None
    if segments:
        try:
            only = [(int(a), int(b)) for a, b in json.loads(segments)]
        except (ValueError, TypeError):
            raise _bad("BAD_SEGMENTS", "segments must be a JSON list of [startMs, endMs]")
    try:
        result = await transcribe(data, provider=provider, client=get_client(), segments=only,
                                  diarize=diarize, num_speakers=numSpeakers)
    except audio.AudioError as e:
        raise _bad("AUDIO_DECODE_FAILED", str(e), 422)
    return result


@router.post("/voice/transcribe-query")
async def transcribe_query(file: UploadFile = File(...)):
    """Voice question (≤ 30 s). The audio is not stored anywhere (spec §6.5)."""
    client = get_client()
    try:
        wav = audio.normalize(await file.read())
    except audio.AudioError as e:
        raise _bad("AUDIO_DECODE_FAILED", str(e), 422)
    pcm = audio.read_pcm(wav)
    dur = audio.duration_ms(pcm)
    if dur > MAX_QUERY_MS:
        raise _bad("TOO_LONG", "Voice questions are limited to 30 seconds")
    usage = UsageLog()
    try:
        res = await client.stt(wav, mode="transcribe", audio_seconds=dur / 1000, usage=usage)
    except SarvamUnavailable:
        raise _bad("PROVIDER_UNAVAILABLE", "Voice questions need Sarvam (voiceMode=sarvam)", 503)
    except SarvamError as e:
        raise _bad("PROVIDER_ERROR", str(e), 502)
    return {"text": res.text, "lang": res.lang, "durationMs": dur, "usage": usage.records}


# ------------------------------------------------------------------ language
class LangItem(BaseModel):
    id: str
    text: str


class LangDetectIn(BaseModel):
    items: list[LangItem] = Field(max_length=2000)
    useProvider: bool = True


@router.post("/lang/detect")
async def lang_detect(body: LangDetectIn):
    client = get_client()
    usage = UsageLog()
    out = []
    for it in body.items:
        lang, conf, ambiguous = lid.detect(it.text)
        source = "heuristic"
        if ambiguous and body.useProvider and client.available and not client.cfg.mock:
            try:
                code, _script = await client.text_lid(it.text[:1000], usage=usage)
                if code:
                    lang, conf, source = code, 0.8, "sarvam"
            except SarvamError:
                pass
        out.append({"id": it.id, "lang": lang, "confidence": conf, "ambiguous": ambiguous, "source": source,
                    "needsTranslation": lid.needs_translation(lang, conf)})
    return {"items": out, "usage": usage.records}


class TranslateItem(BaseModel):
    id: str
    text: str
    src: str | None = None
    pii: dict[str, str] | None = None  # literal → type, e.g. {"Rahul K": "PERSON"}


class TranslateIn(BaseModel):
    items: list[TranslateItem] = Field(max_length=500)
    target: str = "en-IN"
    redact: bool = True


def _sarvam_src(src: str | None) -> str:
    # Romanized Hindi has no BCP-47 code at Sarvam; let it auto-detect.
    return "auto" if not src or src.endswith("-Latn") else src


@router.post("/translate")
async def translate_route(body: TranslateIn):
    client = get_client()
    if not client.available:
        raise _bad("PROVIDER_UNAVAILABLE", "Sarvam is not configured (translateMode needs a key)", 503)
    usage = UsageLog()
    sem = asyncio.Semaphore(3)

    async def one(it: TranslateItem) -> dict:
        text, mapping = redact(it.text, it.pii) if body.redact else (it.text, {})
        async with sem:
            for attempt in range(2):
                try:
                    out, src = await client.translate(text, source=_sarvam_src(it.src), target=body.target, usage=usage)
                except SarvamError as e:
                    return {"id": it.id, "text": None, "src": it.src, "provider": "sarvam", "error": str(e)}
                restored, ok = restore(out, mapping)
                if ok:
                    return {"id": it.id, "text": restored, "src": src or it.src, "provider": "sarvam",
                            "model": client.cfg.translate_model, "redacted": bool(mapping)}
        # Placeholders were dropped or altered twice: keep the untranslated text (spec §6.3).
        return {"id": it.id, "text": None, "src": it.src, "provider": "sarvam", "error": "PLACEHOLDER_MISMATCH"}

    return {"items": list(await asyncio.gather(*[one(i) for i in body.items])), "usage": usage.records}


# ------------------------------------------------------------------ TTS
class TtsIn(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)
    lang: str = "en-IN"
    voice: str | None = None


_CITATION = re.compile(r"\s*\[E\d+:\d+\](?:\s*\[E\d+:\d+\])*")
_SENT = re.compile(r"(?<=[.!?।])\s+")


def split_sentences(text: str) -> list[str]:
    text = _CITATION.sub("", text)
    out: list[str] = []
    for s in (p.strip() for p in _SENT.split(text)):
        while len(s) > TTS_CHUNK_CHARS:
            cut = s.rfind(" ", 0, TTS_CHUNK_CHARS)
            cut = cut if cut > 0 else TTS_CHUNK_CHARS
            out.append(s[:cut])
            s = s[cut:].strip()
        if s:
            out.append(s)
    return out


@router.post("/tts")
async def tts_route(body: TtsIn):
    client = get_client()
    if not client.available:
        raise _bad("PROVIDER_UNAVAILABLE", "Read-aloud needs Sarvam (voiceMode=sarvam)", 503)
    sentences = split_sentences(body.text)
    if not sentences:
        raise _bad("EMPTY", "Nothing to read")
    usage = UsageLog()
    sem = asyncio.Semaphore(3)

    async def one(s: str) -> bytes:
        async with sem:
            return audio.normalize(await client.tts(s, lang=body.lang, speaker=body.voice, usage=usage))

    try:
        wavs = await asyncio.gather(*[one(s) for s in sentences])
    except SarvamError as e:
        raise _bad("PROVIDER_ERROR", str(e), 502)
    except audio.AudioError as e:
        raise _bad("AUDIO_DECODE_FAILED", str(e), 502)

    pcm, timings, t = [], [], 0
    for i, w in enumerate(wavs):
        p = audio.read_pcm(w)
        d = audio.duration_ms(p)
        timings.append({"i": i, "startMs": t, "endMs": t + d, "chars": len(sentences[i])})
        t += d
        pcm.append(p)
    joined = pcm[0]
    for p in pcm[1:]:
        joined.extend(p)
    return Response(
        content=audio.to_wav(joined), media_type="audio/wav",
        headers={"X-Sentence-Timings": json.dumps(timings), "X-Provider-Usage": json.dumps(usage.records)},
    )
