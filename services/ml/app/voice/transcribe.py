"""Evidence audio transcription orchestration (spec §6.1).

normalize → VAD segment (≤ 25 s) → per segment, in parallel:
    STT mode=transcribe (original language)  +  STT mode=translate (English working copy)
    translate fallback on the original transcript if the speech-translate call fails
→ a failed segment becomes `[untranscribed]`, never failing the file.

Provider fallback to local whisper happens for the whole file when Sarvam is unusable
(local mode, no key, or every segment failing with a provider error).
"""
from __future__ import annotations

import asyncio
from typing import Any

from . import audio, local_whisper
from .sarvam_client import SarvamClient, SarvamError, SarvamUnavailable, UsageLog

UNTRANSCRIBED = "[untranscribed]"
STT_CONCURRENCY = 3


def _dominant_lang(segments: list[dict[str, Any]]) -> str | None:
    weight: dict[str, int] = {}
    for s in segments:
        if s.get("lang"):
            weight[s["lang"]] = weight.get(s["lang"], 0) + (s["endMs"] - s["startMs"])
    return max(weight, key=weight.get) if weight else None


async def _sarvam_segment(client: SarvamClient, wav: bytes, seg: audio.Segment, usage: UsageLog,
                          sem: asyncio.Semaphore) -> dict[str, Any]:
    secs = seg.duration_ms / 1000
    out: dict[str, Any] = {"startMs": seg.start_ms, "endMs": seg.end_ms}
    async with sem:
        orig, en = await asyncio.gather(
            client.stt(wav, mode="transcribe", audio_seconds=secs, usage=usage),
            client.stt(wav, mode="translate", audio_seconds=secs, usage=usage),
            return_exceptions=True,
        )
    if isinstance(orig, BaseException):
        if isinstance(orig, SarvamUnavailable):
            raise orig
        out.update(text=UNTRANSCRIBED, textEn=None, lang=None, langConfidence=None, failed=True,
                   error=str(orig))
        return out
    out.update(text=orig.text, lang=orig.lang, langConfidence=orig.lang_confidence)
    if not isinstance(en, BaseException):
        out["textEn"] = en.text
    elif orig.lang and orig.lang.startswith("en"):
        out["textEn"] = orig.text
    else:
        try:
            out["textEn"], _ = await client.translate(orig.text, source=orig.lang or "auto", usage=usage)
            out["textEnVia"] = "translate"
        except SarvamError:
            out["textEn"] = None
    if orig.lang and orig.lang.startswith("en") and not out.get("textEn"):
        out["textEn"] = orig.text
    return out


async def transcribe_sarvam(client: SarvamClient, pcm, usage: UsageLog,
                            only: list[tuple[int, int]] | None = None) -> list[dict[str, Any]]:
    segs = [audio.Segment(a, b) for a, b in only] if only else audio.segment(pcm)
    sem = asyncio.Semaphore(STT_CONCURRENCY)
    return list(await asyncio.gather(*[
        _sarvam_segment(client, audio.slice_wav(pcm, s), s, usage, sem) for s in segs
    ]))


async def transcribe_local(wav: bytes) -> dict[str, Any]:
    if not local_whisper.available():
        raise SarvamUnavailable("local fallback unavailable: faster-whisper is not installed")
    res = await asyncio.to_thread(local_whisper.transcribe, wav)
    for s in res["segments"]:
        s["lang"] = res["lang"]
        s["langConfidence"] = res["langConfidence"]
        # No translation offline (spec §5.12): English audio is its own working copy.
        s["textEn"] = s["text"] if (res["lang"] or "").startswith("en") else None
    return res


async def transcribe(data: bytes, *, provider: str = "sarvam", client: SarvamClient,
                     segments: list[tuple[int, int]] | None = None) -> dict[str, Any]:
    """Returns the `transcript` artifact payload plus `usage` and `fallback` info."""
    wav = audio.normalize(data)
    pcm = audio.read_pcm(wav)
    dur = audio.duration_ms(pcm)
    usage = UsageLog()
    fallback_reason: str | None = None

    if provider == "sarvam":
        if not client.available:
            fallback_reason = "sarvam_unconfigured"
        else:
            try:
                segs = await transcribe_sarvam(client, pcm, usage, only=segments)
            except SarvamUnavailable:
                fallback_reason = "sarvam_unconfigured"
            else:
                provider_errors = [s for s in segs if s.get("failed")]
                if segs and len(provider_errors) == len(segs):
                    fallback_reason = "sarvam_failed"
                else:
                    return {
                        "lang": _dominant_lang(segs), "provider": "sarvam", "model": client.cfg.stt_model,
                        "durationMs": dur, "segments": segs, "usage": usage.records, "fallback": None,
                    }

    try:
        res = await transcribe_local(wav)
    except SarvamUnavailable as e:
        # Neither provider works: return placeholder segments so the file still has structure + retry buttons.
        segs = [{"startMs": s.start_ms, "endMs": s.end_ms, "text": UNTRANSCRIBED, "textEn": None,
                 "lang": None, "failed": True, "error": str(e)} for s in audio.segment(pcm)]
        return {"lang": None, "provider": "none", "model": None, "durationMs": dur, "segments": segs,
                "usage": usage.records, "fallback": fallback_reason or "local_unavailable"}
    return {"lang": res["lang"], "provider": "local_whisper", "model": f"faster-whisper:{_whisper_name()}",
            "durationMs": dur, "segments": res["segments"], "usage": usage.records, "fallback": fallback_reason}


def _whisper_name() -> str:
    import os

    return os.environ.get("WHISPER_MODEL", "small")
