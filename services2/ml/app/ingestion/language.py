from __future__ import annotations

import os
import re
from typing import Any

import httpx

DEVANAGARI = re.compile(r"[\u0900-\u097f]")
TAMIL = re.compile(r"[\u0b80-\u0bff]")
TELUGU = re.compile(r"[\u0c00-\u0c7f]")
KANNADA = re.compile(r"[\u0c80-\u0cff]")
MALAYALAM = re.compile(r"[\u0d00-\u0d7f]")


def detect(text: str) -> dict[str, Any]:
    letters = max(1, sum(char.isalpha() for char in text))
    scripts = [("hi", "Devanagari", DEVANAGARI), ("ta", "Tamil", TAMIL), ("te", "Telugu", TELUGU), ("kn", "Kannada", KANNADA), ("ml", "Malayalam", MALAYALAM)]
    counts = [(lang, name, len(pattern.findall(text))) for lang, name, pattern in scripts]
    lang, script, count = max(counts, key=lambda row: row[2])
    if count:
        return {"language": lang, "script": script, "confidence": min(.99, count / letters), "provider": "script_heuristic", "warnings": ["Script detection is a heuristic, not language identification."]}
    try:
        import langid
        language, score = langid.classify(text)
        return {"language": language, "script": "Latin", "confidence": max(0.0, min(1.0, 1 / (1 + abs(score)))), "provider": "langid", "warnings": []}
    except ImportError:
        return {"language": "en", "script": "Latin", "confidence": None, "provider": "fallback", "warnings": ["Install langid for Latin-script language detection; Hinglish may require review."]}


def translate(text: str, source_language: str | None, target_language: str = "en") -> dict[str, Any]:
    key = os.getenv("SARVAM_API_KEY")
    if not key:
        raise RuntimeError("SARVAM_API_KEY is not configured")
    url = os.getenv("SARVAM_TRANSLATE_URL", "https://api.sarvam.ai/translate")
    model = os.getenv("SARVAM_TRANSLATE_MODEL", "sarvam-translate:v1")
    if model == "sarvam-translate:v1" and len(text) > 2000:
        raise ValueError("Sarvam Translate accepts at most 2000 characters per request")
    if model == "mayura:v1" and len(text) > 1000:
        raise ValueError("Sarvam Mayura accepts at most 1000 characters per request")
    detected_language = source_language or detect(text).get("language")
    source = _sarvam_code(str(detected_language)) if detected_language else "auto"
    target = _sarvam_code(target_language)
    payload = {"input": text, "source_language_code": source, "target_language_code": target, "model": model}
    response = httpx.post(url, json=payload, headers={"api-subscription-key": key}, timeout=90)
    response.raise_for_status()
    result = response.json()
    translated = result.get("translated_text") or result.get("translatedText") or ""
    if isinstance(translated, list):
        translated = translated[0] if translated else ""
    if not str(translated).strip():
        raise RuntimeError("Sarvam translation returned empty text")
    return {"sourceLanguage": result.get("source_language_code", source_language), "targetLanguage": target, "translatedText": translated, "provider": model, "warnings": []}


def _sarvam_code(language: str) -> str:
    value = language.strip()
    if value.lower() in {"en", "english"}:
        return "en-IN"
    return value if "-" in value else f"{value}-IN"


def english_working_text(text: str, language: str | None = None) -> tuple[str, str | None, list[str]]:
    detected = detect(text) if not language else {"language": language}
    lang = str(detected.get("language") or "en")
    if lang.lower().split("-")[0] == "en":
        return text, lang, []
    pieces = _translation_pieces(text, 1900)
    translated = [str(translate(piece, lang, "en-IN")["translatedText"]) for piece in pieces]
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
