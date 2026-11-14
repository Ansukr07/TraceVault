from __future__ import annotations

import os

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile

from app.schemas import TranscriptionResponse, TranscriptionSegment
from app.ingestion.language import english_working_text
from app.voice import local_whisper, sarvam_stt

router = APIRouter(prefix="/transcribe", tags=["voice"])


@router.post("", response_model=TranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    provider: str = Form("sarvam"),
    mode: str = Form("transcribe"),
    diarize: bool = Form(False),
    allow_fallback: bool = Form(True),
    translate_to_english: bool = Form(True),
    x_internal_secret: str | None = Header(default=None),
) -> TranscriptionResponse:
    _authorize(x_internal_secret)
    if provider not in {"sarvam", "local"} or mode not in {"transcribe", "translate"}:
        raise HTTPException(422, "provider must be sarvam|local and mode transcribe|translate")
    content = await file.read()
    warnings: list[str] = []
    actual_provider = provider
    try:
        data = local_whisper.transcribe(content, file.filename or "audio.bin", mode) if provider == "local" else sarvam_stt.transcribe(content, file.filename or "audio.bin", mode, diarize)
    except Exception as exc:
        if provider != "sarvam" or not allow_fallback:
            raise HTTPException(502, f"Speech provider failed: {exc}") from exc
        try:
            data = local_whisper.transcribe(content, file.filename or "audio.bin", mode)
            actual_provider = "local"
            warnings.append(f"Sarvam failed; used local faster-whisper fallback: {exc}")
        except Exception as fallback_exc:
            raise HTTPException(503, f"Sarvam and local speech fallback failed: {fallback_exc}") from fallback_exc
    segments_data = data.get("segments") or data.get("timestamps") or []
    segments = []
    for item in segments_data:
        start = item.get("start", item.get("start_time", 0))
        end = item.get("end", item.get("end_time", start))
        text = item.get("text", item.get("transcript", ""))
        segment_language = item.get("language", data.get("language_code"))
        text_en = str(text)
        if translate_to_english:
            try:
                text_en, detected_language, _ = english_working_text(str(text), segment_language)
                segment_language = segment_language or detected_language
            except Exception as exc:
                warnings.append(f"Segment translation failed: {exc}")
                text_en = None
        segments.append(TranscriptionSegment(start=float(start), end=float(end), text=str(text), textEn=text_en, language=segment_language, speaker=item.get("speaker_id"), words=item.get("words", [])))
    language = data.get("language", data.get("language_code"))
    for segment in segments:
        if not segment.language:
            segment.language = language
    return TranscriptionResponse(language=language, provider=actual_provider, mode=mode, segments=segments, warnings=warnings)


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
