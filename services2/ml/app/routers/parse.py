from __future__ import annotations

import io
import base64
import os
import zipfile

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile

from app.ingestion import chat_exports, email as email_parser, pdf, screenshot_chat, whatsapp
from app.ingestion.metadata import extract_metadata
from app.ocr.pipeline import OCRPipeline
from app.schemas import ParsedDocumentResponse, ParsedEmailResponse, ParseMessagesResponse

router = APIRouter(tags=["parsers"])
ocr_pipeline = OCRPipeline()


@router.post("/parse/whatsapp")
async def parse_whatsapp(file: UploadFile = File(...), date_order: str = Form("auto"), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    content = await file.read()
    if (file.filename or "").lower().endswith(".zip"):
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
            txt_files = [name for name in archive.namelist() if name.lower().endswith(".txt") and not name.startswith("__MACOSX/")]
            if not txt_files:
                raise ValueError("WhatsApp ZIP contains no .txt chat export")
            chat = whatsapp.parse(archive.read(txt_files[0]).decode("utf-8-sig", errors="replace"), date_order)
            media = []
            for name in archive.namelist():
                if name.endswith("/") or name.lower().endswith(".txt") or name.startswith("__MACOSX/"):
                    continue
                child = archive.read(name)
                media.append({"filename": name, "size": len(child), "parentFilename": file.filename, "attachedName": name.rsplit("/", 1)[-1], "childEvidence": True, "bytesBase64": base64.b64encode(child).decode("ascii")})
            return {**chat, "archive": {"chatFilename": txt_files[0], "childMedia": media}}
        except (zipfile.BadZipFile, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
    try:
        return whatsapp.parse(content.decode("utf-8-sig", errors="replace"), date_order)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/parse/telegram", response_model=ParseMessagesResponse)
async def parse_telegram(file: UploadFile = File(...), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    return _parse_json_export(await file.read(), "telegram")


@router.post("/parse/instagram", response_model=ParseMessagesResponse)
async def parse_instagram(file: UploadFile = File(...), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    return _parse_json_export(await file.read(), "instagram")


@router.post("/parse/takeout", response_model=ParseMessagesResponse)
async def parse_takeout(file: UploadFile = File(...), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    return _parse_json_export(await file.read(), "takeout")


@router.post("/parse/pdf", response_model=ParsedDocumentResponse)
async def parse_pdf(file: UploadFile = File(...), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    try:
        return pdf.parse_pdf(await file.read(), ocr_pipeline)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(415, str(exc)) from exc


@router.post("/parse/screenshot-chat")
async def parse_screenshot_chat(file: UploadFile = File(...), use_llm: bool = Form(True), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    try:
        ocr_result = ocr_pipeline.extract(await file.read())
        structured = screenshot_chat.structure_ocr([line.model_dump() for line in ocr_result.lines], use_llm)
        return {**structured, "ocrLines": [line.model_dump() for line in ocr_result.lines], "providers": ocr_result.providers, "warnings": ocr_result.warnings + structured["warnings"]}
    except ValueError as exc:
        raise HTTPException(415, str(exc)) from exc


@router.post("/parse/eml", response_model=ParsedEmailResponse)
async def parse_eml(file: UploadFile = File(...), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    try:
        return email_parser.parse_eml(await file.read())
    except Exception as exc:
        raise HTTPException(422, f"Could not parse EML: {exc}") from exc


@router.post("/metadata")
async def metadata(file: UploadFile = File(...), mime: str | None = Form(None), uploaded_at: str | None = Form(None), file_times_json: str | None = Form(None), x_internal_secret: str | None = Header(default=None)):
    _authorize(x_internal_secret)
    import json
    try:
        file_times = json.loads(file_times_json) if file_times_json else None
    except json.JSONDecodeError as exc:
        raise HTTPException(422, "file_times_json must be a JSON object") from exc
    return extract_metadata(await file.read(), file.filename or "upload.bin", mime, uploaded_at, file_times)


def _parse_json_export(content: bytes, source: str):
    try:
        return chat_exports.parse_json_text(content.decode("utf-8-sig", errors="replace"), source)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _authorize(value: str | None) -> None:
    expected = os.getenv("INTERNAL_SECRET")
    if expected and value != expected:
        raise HTTPException(401, "Invalid internal service credential")
