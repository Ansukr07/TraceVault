"""Format-specific parse endpoints (ingestion views). /extract is the chunked pipeline the Node API uses."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import zipfile
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..ingestion import chat_exports, email as email_parser, pdf, screenshot_chat, whatsapp
from ..ingestion.metadata import extract_metadata
from ..ocr.pipeline import ocr_image
from ..schemas import ParsedDocumentResponse, ParsedEmailResponse, ParseMessagesResponse

router = APIRouter(tags=["parsers"])
MAX_CHILD_BYTES = 50 * 1024 * 1024
OcrProvider = Literal["local", "auto", "google", "sarvam"]


@router.post("/parse/whatsapp")
async def parse_whatsapp(file: UploadFile = File(...), date_order: str = Form("auto")):
    content = await file.read()
    if not (file.filename or "").lower().endswith(".zip"):
        return await asyncio.to_thread(whatsapp.parse, content.decode("utf-8-sig", errors="replace"), date_order)

    def unzip():
        archive = zipfile.ZipFile(io.BytesIO(content))
        names = [n for n in archive.namelist() if not n.startswith("__MACOSX/") and not n.endswith("/")]
        txt = [n for n in names if n.lower().endswith(".txt")]
        if not txt:
            raise ValueError("WhatsApp ZIP contains no .txt chat export")
        chat = whatsapp.parse(archive.read(txt[0]).decode("utf-8-sig", errors="replace"), date_order)
        media, total = [], 0
        for info in archive.infolist():
            if info.filename not in names or info.filename in txt or info.file_size > MAX_CHILD_BYTES:
                continue
            total += info.file_size
            if total > 4 * MAX_CHILD_BYTES:  # zip-bomb guard
                chat["warnings"].append("Archive media truncated at the size limit.")
                break
            media.append({"filename": info.filename, "size": info.file_size, "parentFilename": file.filename,
                          "attachedName": info.filename.rsplit("/", 1)[-1], "childEvidence": True,
                          "bytesBase64": base64.b64encode(archive.read(info)).decode("ascii")})
        return {**chat, "archive": {"chatFilename": txt[0], "childMedia": media}}

    try:
        return await asyncio.to_thread(unzip)
    except (zipfile.BadZipFile, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


def _json_export(content: bytes, source: str):
    try:
        return chat_exports.parse_json_text(content.decode("utf-8-sig", errors="replace"), source)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/parse/telegram", response_model=ParseMessagesResponse)
async def parse_telegram(file: UploadFile = File(...)):
    return _json_export(await file.read(), "telegram")


@router.post("/parse/instagram", response_model=ParseMessagesResponse)
async def parse_instagram(file: UploadFile = File(...)):
    return _json_export(await file.read(), "instagram")


@router.post("/parse/takeout", response_model=ParseMessagesResponse)
async def parse_takeout(file: UploadFile = File(...)):
    return _json_export(await file.read(), "takeout")


@router.post("/parse/pdf", response_model=ParsedDocumentResponse)
async def parse_pdf(file: UploadFile = File(...), ocr_provider: OcrProvider = Form("auto")):
    data = await file.read()
    try:
        return await asyncio.to_thread(pdf.parse_pdf, data, ocr_provider)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(415, str(exc)) from exc


@router.post("/parse/screenshot-chat")
async def parse_screenshot_chat(file: UploadFile = File(...), use_llm: bool = Form(False), ocr_provider: OcrProvider = Form("auto"),
                                reference_date: str | None = Form(None)):
    data = await file.read()

    def work():
        res = ocr_image(data, provider=ocr_provider)
        structured = screenshot_chat.structure_ocr(res, reference_date, use_llm)
        warnings = structured["warnings"] + (["No OCR engine available."] if res.get("unavailable") else [])
        return {**structured, "ocrLines": res["lines"] + res.get("textLines", []), "providers": [res["provider"]] if res["provider"] else [],
                "width": res["width"], "height": res["height"], "warnings": warnings}

    try:
        return await asyncio.to_thread(work)
    except Exception as exc:  # noqa: BLE001  — unreadable image
        raise HTTPException(415, f"Uploaded file is not a readable image: {type(exc).__name__}") from exc


@router.post("/parse/eml", response_model=ParsedEmailResponse)
async def parse_eml(file: UploadFile = File(...)):
    try:
        return email_parser.parse_eml(await file.read())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Could not parse EML: {exc}") from exc


@router.post("/metadata")
async def metadata(file: UploadFile = File(...), mime: str | None = Form(None), uploaded_at: str | None = Form(None),
                   file_times_json: str | None = Form(None)):
    try:
        file_times = json.loads(file_times_json) if file_times_json else None
    except json.JSONDecodeError as exc:
        raise HTTPException(422, "file_times_json must be a JSON object") from exc
    data = await file.read()
    return await asyncio.to_thread(extract_metadata, data, file.filename or "upload.bin", mime or file.content_type, uploaded_at, file_times)
