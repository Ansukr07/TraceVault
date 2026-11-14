"""Language detection and the English working copy (synchronous API for OCR, STT and NLP).

Detection: local script / romanized-Hindi heuristic (`app.lang.detect`), then `langid` for other
Latin-script text when installed. Translation: Sarvam Translate (sarvam-translate:v1, 2,000 chars
per request; mayura:v1, 1,000) with Google Cloud Translation as fallback. Source text is never
modified; callers keep both.

The async batch path used by /extract lives in `app.lang.translate.annotate_chunks`.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

from ..lang import detect as lid

_SCRIPT_NAMES = {"hi": "Devanagari", "bn": "Bengali", "pa": "Gurmukhi", "gu": "Gujarati", "od": "Odia",
                 "ta": "Tamil", "te": "Telugu", "kn": "Kannada", "ml": "Malayalam"}


def detect(text: str) -> dict[str, Any]:
    code, conf, ambiguous = lid.detect(text)
    if code and not code.startswith("en"):
        base = code.split("-")[0]
        script = "Latin" if code.endswith("-Latn") else _SCRIPT_NAMES.get(base, "Indic")
        warnings = ["Romanized Hindi detected by word-list heuristic; review if mixed."] if script == "Latin" else []
        return {"language": base, "tag": code, "script": script, "confidence": conf, "provider": "script_heuristic", "warnings": warnings}
    if ambiguous:
        try:
            import langid

            language, score = langid.classify(text)
            return {"language": language, "tag": language, "script": "Latin", "confidence": max(0.0, min(1.0, 1 / (1 + abs(score)))), "provider": "langid", "warnings": []}
        except ImportError:
            pass
    return {"language": "en" if code else None, "tag": code, "script": "Latin" if code else None, "confidence": conf,
            "provider": "script_heuristic", "warnings": ["Ambiguous Latin-script text; Hinglish may require review."] if ambiguous else []}


def _sarvam_code(language: str) -> str:
    value = language.strip()
    if value.lower() in {"en", "english"}:
        return "en-IN"
    if value.endswith("-Latn"):
        return "auto"
    return value if "-" in value else f"{value}-IN"


def _translate_sarvam(text: str, source: str | None, target: str) -> dict[str, Any]:
    key = os.environ["SARVAM_API_KEY"]
    url = os.getenv("SARVAM_TRANSLATE_URL", "https://api.sarvam.ai/translate")
    model = os.getenv("SARVAM_TRANSLATE_MODEL", "sarvam-translate:v1")
    limit = 1000 if model.startswith("mayura") else 2000
    if len(text) > limit:
        raise ValueError(f"{model} accepts at most {limit} characters per request")
    src = _sarvam_code(source) if source else "auto"
    payload = {"input": text, "source_language_code": src, "target_language_code": _sarvam_code(target), "model": model}
    response = httpx.post(url, json=payload, headers={"api-subscription-key": key}, timeout=90)
    response.raise_for_status()
    result = response.json()
    translated = result.get("translated_text") or result.get("translatedText") or ""
    if isinstance(translated, list):
        translated = translated[0] if translated else ""
    if not str(translated).strip():
        raise RuntimeError("Sarvam translation returned empty text")
    return {"sourceLanguage": result.get("source_language_code", source), "targetLanguage": _sarvam_code(target),
            "translatedText": translated, "provider": model, "warnings": []}


def _translate_google(text: str, source: str | None, target: str) -> dict[str, Any]:
    from ..lang.google_cloud import get_google

    out, detected = asyncio.run(get_google().translate(text, source, target))
    return {"sourceLanguage": detected or source, "targetLanguage": target, "translatedText": out, "provider": "google_nmt", "warnings": []}


def translate(text: str, source_language: str | None, target_language: str = "en") -> dict[str, Any]:
    """TRANSLATE_PROVIDER = auto (Sarvam, else Google) | sarvam | google."""
    source = source_language or detect(text).get("language")
    pref = os.environ.get("TRANSLATE_PROVIDER", "auto").strip().lower()
    if pref in ("auto", "sarvam") and os.getenv("SARVAM_API_KEY"):
        return _translate_sarvam(text, source, target_language)
    if pref in ("auto", "google") and os.getenv("GOOGLE_API_KEY"):
        return _translate_google(text, source, target_language)
    raise RuntimeError("No translation provider configured (set SARVAM_API_KEY or GOOGLE_API_KEY)")


def english_working_text(text: str, language: str | None = None) -> tuple[str, str | None, list[str]]:
    """(English text, source language, warnings). English input is returned unchanged; long text is translated in pieces."""
    lang = str(language or detect(text).get("language") or "en")
    if lang.lower().split("-")[0] == "en":
        return text, lang, []
    pieces = _translation_pieces(text, 1900)
    translated = [str(translate(piece, lang, "en")["translatedText"]) for piece in pieces]
    return "\n".join(translated), lang, []


def _translation_pieces(text: str, limit: int) -> list[str]:
    pieces: list[str] = []
    remaining = text
    while len(remaining) > limit:
        split = max(remaining.rfind("\n", 0, limit), remaining.rfind(" ", 0, limit))
        if split < limit // 2:
            split = limit
        pieces.append(remaining[:split].strip())
        remaining = remaining[split:].strip()
    if remaining:
        pieces.append(remaining)
    return pieces
