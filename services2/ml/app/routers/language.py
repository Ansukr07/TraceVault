from __future__ import annotations

import os

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.ingestion.language import detect, translate

router = APIRouter(prefix="/lang", tags=["language"])


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)


class TranslateRequest(TextRequest):
    sourceLanguage: str | None = None
    targetLanguage: str = "en"


@router.post("/detect")
def detect_language(request: TextRequest, x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    return detect(request.text)


@router.post("/translate")
def translate_text(request: TranslateRequest, x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    try:
        return translate(request.text, request.sourceLanguage, request.targetLanguage)
    except Exception as exc:
        raise HTTPException(502, f"Sarvam translation failed: {exc}") from exc


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
