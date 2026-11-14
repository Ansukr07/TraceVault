"""Offline fallback STT (spec §6.1 step 6): faster-whisper, CPU, loaded lazily.

faster-whisper is optional; when missing, `available()` is False and callers mark
segments `[untranscribed]` instead of crashing.
"""
from __future__ import annotations

import io
import os
import threading
from typing import Any

_model = None
_lock = threading.Lock()


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def _get_model():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
    return _model


def loaded() -> bool:
    return _model is not None


def transcribe(wav: bytes) -> dict[str, Any]:
    """Blocking; run in a thread. Returns {lang, langConfidence, segments:[{startMs,endMs,text,words}]}."""
    model = _get_model()
    segs, info = model.transcribe(io.BytesIO(wav), word_timestamps=True, vad_filter=True)
    out = []
    for s in segs:
        out.append({
            "startMs": int(s.start * 1000),
            "endMs": int(s.end * 1000),
            "text": s.text.strip(),
            "words": [{"w": w.word.strip(), "startMs": int(w.start * 1000), "endMs": int(w.end * 1000)}
                      for w in (s.words or [])],
        })
    lang = info.language
    return {"lang": f"{lang}-IN" if lang and len(lang) == 2 else lang,
            "langConfidence": info.language_probability, "segments": out}
