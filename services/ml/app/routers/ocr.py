"""Standalone OCR: English pipeline, then local-language pipeline per `provider`."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..ocr.pipeline import OCRPipeline
from ..schemas import OCRResponse

router = APIRouter(prefix="/ocr", tags=["ocr"])
pipeline = OCRPipeline()


@router.post("", response_model=OCRResponse)
async def ocr(file: UploadFile = File(...), provider: Literal["local", "auto", "google", "sarvam"] | None = Form(None)) -> OCRResponse:
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty image")
    try:
        return await pipeline.aextract(content, provider)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from exc
