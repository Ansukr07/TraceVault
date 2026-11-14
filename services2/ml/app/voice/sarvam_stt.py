from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx


def transcribe(audio: bytes, filename: str, mode: str = "transcribe", diarize: bool = False) -> dict[str, Any]:
    """Submit audio to Saaras v4; return provider-native JSON for normalization."""
    key = os.getenv("SARVAM_API_KEY")
    if not key:
        raise RuntimeError("SARVAM_API_KEY is not configured")
    url = os.getenv("SARVAM_STT_URL", "https://api.sarvam.ai/speech-to-text")
    model = os.getenv("SARVAM_STT_MODEL", "saaras:v4")
    mime = _mime_for(filename)
    data = {"model": model, "mode": mode, "diarize": str(diarize).lower()}
    files = {"file": (Path(filename).name or "audio.bin", audio, mime)}
    response = httpx.post(url, data=data, files=files, headers={"api-subscription-key": key}, timeout=180)
    response.raise_for_status()
    return response.json()


def _mime_for(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    return {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg", ".opus": "audio/ogg"}.get(suffix, "application/octet-stream")
