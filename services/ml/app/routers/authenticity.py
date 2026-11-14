"""POST /authenticity/image: manipulation indicators for one image (future spec F1)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..authenticity.image import analyze

router = APIRouter()
MAX_BYTES = 60 * 1024 * 1024


@router.post("/authenticity/image")
async def authenticity_image(file: UploadFile = File(...)):
    data = await file.read()
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(422, {"code": "BAD_INPUT", "message": "Empty or oversized image"})
    try:
        return await asyncio.to_thread(analyze, data)
    except Exception as e:  # noqa: BLE001  (undecodable / truncated image)
        raise HTTPException(422, {"code": "UNREADABLE_IMAGE", "message": f"Could not analyse image: {type(e).__name__}"}) from e
