from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any


def transcribe(audio: bytes, filename: str, mode: str = "transcribe") -> dict[str, Any]:
    """CPU-compatible offline fallback. Install ffmpeg for non-WAV formats."""
    from faster_whisper import WhisperModel

    model_name = os.getenv("WHISPER_MODEL", "small")
    model = WhisperModel(model_name, device=os.getenv("WHISPER_DEVICE", "cpu"), compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"))
    suffix = Path(filename).suffix or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(audio)
        path = handle.name
    try:
        segments, info = model.transcribe(path, task="translate" if mode == "translate" else "transcribe", vad_filter=True, word_timestamps=True)
        normalized = []
        for segment in segments:
            normalized.append({
                "start": segment.start, "end": segment.end, "text": segment.text.strip(),
                "words": [{"start": word.start, "end": word.end, "text": word.word, "confidence": word.probability} for word in (segment.words or [])],
            })
        return {"language": info.language, "segments": normalized}
    finally:
        os.unlink(path)
