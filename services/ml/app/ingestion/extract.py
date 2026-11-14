"""Per-evidence extraction dispatcher (spec §5.4, §7).

Input: original bytes + kind. Output (all JSON):
    {artifactType, artifact, chunks[], metadata, flags[], hashes?, children[]}
Each chunk is the atomic unit of citation: {idx, text, locator, refTs, sender?, unit, conf?}.
`children` (zip/eml attachments) are returned base64-encoded for Node to seal as child evidence.

Format parsers live beside this file: whatsapp, chat_exports, screenshot_chat, pdf, email, metadata.
"""
from __future__ import annotations

import base64
import io
import zipfile
from typing import Any

from ..ocr.pipeline import ocr_image
from . import metadata as md
from .chat_exports import parse_json_chat
from .chunking import paragraphs as _paragraphs  # noqa: F401  (kept for callers of the old name)
from .email import MAX_CHILD_BYTES, extract_email  # noqa: F401
from .pdf import extract_pdf  # noqa: F401
from .screenshot_chat import _blocks, parse_screenshot
from .whatsapp import parse_whatsapp

LOW_CONF = 0.6
GENERATOR_VERSION = 1


# ------------------------------------------------------------------ chat export
def extract_chat(data: bytes) -> dict[str, Any]:
    head = data.decode("utf-8-sig", errors="ignore").lstrip()[:1]
    chat = parse_json_chat(data) if head in ("{", "[") else None
    if chat is None:
        chat = parse_whatsapp(data.decode("utf-8", errors="replace"))
    chunks = []
    for m in chat.messages:
        if m.is_system:
            continue
        chunks.append({
            "idx": len(chunks), "text": m.text, "unit": "message", "sender": m.sender,
            "refTs": m.ts.isoformat() if m.ts else None, "media": m.media,
            "locator": {"messageIdx": m.idx, "lineNo": m.line_no},
        })
    artifact = {
        "dateOrder": chat.date_order, "participants": chat.participants,
        "messages": [{"idx": m.idx, "lineNo": m.line_no, "ts": m.ts.isoformat() if m.ts else None, "sender": m.sender,
                      "text": m.text, "media": m.media, "system": m.is_system} for m in chat.messages],
    }
    flags = []
    # IMPOSSIBLE_SEQUENCE: timestamps running backwards in an export suggests editing.
    prev = None
    for m in chat.messages:
        if m.ts and prev and (prev.ts - m.ts).total_seconds() > 120:
            flags.append({"type": "IMPOSSIBLE_SEQUENCE", "field": "messageOrder",
                          "value": f"message {m.idx} ({m.ts.isoformat()}) is earlier than message {prev.idx} ({prev.ts.isoformat()})",
                          "messageIdx": m.idx})
        if m.ts:
            prev = m
    return {"artifactType": "parsed_chat", "artifact": artifact, "chunks": chunks,
            "metadata": {"participants": chat.participants, "messages": len(chat.messages), "dateOrder": chat.date_order},
            "flags": flags, "children": []}


# ------------------------------------------------------------------ image
def extract_image(data: bytes, reference_ts: str | None = None, ocr_provider: str = "local") -> dict[str, Any]:
    meta, flags = md.image_metadata(data)
    hashes = md.image_hashes(data)
    res = ocr_image(data, provider=ocr_provider)
    ref_date = (meta.get("captureTime") or reference_ts or "")[:10] or None
    chat = parse_screenshot(res, ref_date)
    chunks: list[dict[str, Any]] = []
    if chat["isChat"]:
        for b in chat["bubbles"]:
            chunks.append({"idx": len(chunks), "text": b["text"], "unit": "bubble", "sender": b["sender"],
                           "refTs": b["ts"], "conf": b["conf"], "lowConfidence": b["conf"] < LOW_CONF,
                           "timeOfDay": b["timeOfDay"], "locator": {"bbox": b["bbox"], "side": b["side"]}})
    else:
        # One chunk per OCR block (consecutive close lines) when it isn't a chat.
        for b in _blocks(res["lines"], res["width"]):
            chunks.append({"idx": len(chunks), "text": b["text"], "unit": "ocr_block", "refTs": None,
                           "conf": b["conf"], "lowConfidence": b["conf"] < LOW_CONF, "locator": {"bbox": b["bbox"]}})
    # Page-level local-language OCR text without geometry (Sarvam Vision): citable by line number only.
    for i, ln in enumerate(res.get("textLines", [])):
        chunks.append({"idx": len(chunks), "text": ln["text"], "unit": "ocr_line", "refTs": None, "conf": ln["conf"],
                       "lowConfidence": ln["conf"] < LOW_CONF, "locator": {"lineIdx": i}})
    # METADATA_MISMATCH: in-image dates vs EXIF capture date (> 1 day apart).
    cap = meta.get("captureTime")
    if cap:
        # A scrolled screenshot spans several days but is captured at the newest message, so compare against the latest date shown.
        dates = [b["date"] for b in chat["bubbles"] if b["date"]]
        latest = max(dates, default=None)
        if latest and abs(_days(latest, cap[:10])) > 1:
            flags.append({"type": "METADATA_MISMATCH", "field": "inImageDate",
                          "value": f"image shows {latest}, EXIF capture {cap[:10]}",
                          "contentDate": latest, "captureDate": cap[:10]})
    if res.get("unavailable"):
        flags.append({"type": "OCR_UNAVAILABLE", "field": "ocr", "value": "OCR engine not installed"})
    artifact = {"width": res["width"], "height": res["height"], "inverted": res["inverted"], "lines": res["lines"],
                "screenshotChat": chat, "ocrProvider": res.get("provider")}
    if res.get("textLines"):
        artifact["textLines"] = res["textLines"]
    meta["ocrProvider"] = res.get("provider")
    return {"artifactType": "ocr", "artifact": artifact, "chunks": chunks, "metadata": meta, "flags": flags,
            "hashes": hashes, "children": [], "usage": res.get("usage", [])}


def _days(a: str, b: str) -> int:
    from datetime import date

    return (date.fromisoformat(a) - date.fromisoformat(b)).days


# ------------------------------------------------------------------ archive (WhatsApp .zip export)
def extract_archive(data: bytes) -> dict[str, Any]:
    zf = zipfile.ZipFile(io.BytesIO(data))
    children, total = [], 0
    for info in zf.infolist():
        if info.is_dir() or info.file_size > MAX_CHILD_BYTES or "__MACOSX" in info.filename:
            continue
        total += info.file_size
        if total > 4 * MAX_CHILD_BYTES:  # zip-bomb guard
            break
        name = info.filename.rsplit("/", 1)[-1]
        children.append({"filename": name, "data": base64.b64encode(zf.read(info)).decode(),
                         "role": "chat" if name.lower().endswith(".txt") else "media"})
    return {"artifactType": "archive", "artifact": {"files": [c["filename"] for c in children]}, "chunks": [],
            "metadata": {"files": len(children)}, "flags": [], "children": children}
