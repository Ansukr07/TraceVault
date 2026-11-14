from __future__ import annotations

import os

from fastapi import APIRouter, File, Header, HTTPException, UploadFile

from app.ocr.pipeline import OCRPipeline
from app.schemas import OCRResponse

router = APIRouter(prefix="/ocr", tags=["ocr"])
pipeline = OCRPipeline()


@router.post("", response_model=OCRResponse)
async def ocr(file: UploadFile = File(...), x_internal_secret: str | None = Header(default=None)) -> OCRResponse:
    _authorize(x_internal_secret)
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty image")
    try:
        return await pipeline.aextract(content)
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from exc


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
