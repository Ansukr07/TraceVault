"""Per-evidence extraction dispatcher (spec §5.4, §7).

Input: original bytes + kind. Output (all JSON):
    {artifactType, artifact, chunks[], metadata, flags[], hashes?, children[]}
Each chunk is the atomic unit of citation: {idx, text, locator, refTs, sender?, unit, conf?}.
`children` (zip/eml attachments) are returned base64-encoded for Node to seal as child evidence.
"""
from __future__ import annotations

import base64
import email
import email.policy
import io
import re
import zipfile
from email.utils import getaddresses, parsedate_to_datetime
from typing import Any

from . import metadata as md
from . import ocr
from .screenshot import parse_screenshot
from .whatsapp import parse_whatsapp

MAX_PARAGRAPH = 800
MAX_CHILD_BYTES = 50 * 1024 * 1024
LOW_CONF = 0.6
GENERATOR_VERSION = 1


def _paragraphs(text: str) -> list[str]:
    out: list[str] = []
    for p in re.split(r"\n\s*\n", text):
        p = re.sub(r"[ \t]+", " ", p).strip()
        while len(p) > MAX_PARAGRAPH:
            cut = max(p.rfind(". ", 0, MAX_PARAGRAPH), p.rfind(" ", 0, MAX_PARAGRAPH))
            cut = cut + 1 if cut > 0 else MAX_PARAGRAPH
            out.append(p[:cut].strip())
            p = p[cut:].strip()
        if p:
            out.append(p)
    return out


# ------------------------------------------------------------------ chat export
def extract_chat(data: bytes) -> dict[str, Any]:
    text = data.decode("utf-8", errors="replace")
    chat = parse_whatsapp(text)
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
def extract_image(data: bytes, reference_ts: str | None = None) -> dict[str, Any]:
    meta, flags = md.image_metadata(data)
    hashes = md.image_hashes(data)
    res = ocr.ocr_image(data)
    ref_date = (meta.get("captureTime") or reference_ts or "")[:10] or None
    chat = parse_screenshot(res, ref_date)
    chunks: list[dict[str, Any]] = []
    if chat["isChat"]:
        for b in chat["bubbles"]:
            chunks.append({"idx": len(chunks), "text": b["text"], "unit": "bubble", "sender": b["sender"],
                           "refTs": b["ts"], "conf": b["conf"], "lowConfidence": b["conf"] < LOW_CONF,
                           "timeOfDay": b["timeOfDay"], "locator": {"bbox": b["bbox"], "side": b["side"]}})
    else:
        lines = res["lines"]
        # One chunk per OCR block (consecutive close lines) when it isn't a chat.
        from .screenshot import _blocks

        for b in _blocks(lines, res["width"]):
            chunks.append({"idx": len(chunks), "text": b["text"], "unit": "ocr_block", "refTs": None,
                           "conf": b["conf"], "lowConfidence": b["conf"] < LOW_CONF, "locator": {"bbox": b["bbox"]}})
    # METADATA_MISMATCH: in-image dates vs EXIF capture date (> 1 day apart).
    cap = meta.get("captureTime")
    if cap:
        for b in chat["bubbles"]:
            if b["date"] and b["date"] != ref_date and abs(_days(b["date"], cap[:10])) > 1:
                flags.append({"type": "METADATA_MISMATCH", "field": "inImageDate",
                              "value": f"image shows {b['date']}, EXIF capture {cap[:10]}"})
                break
    if res.get("unavailable"):
        flags.append({"type": "OCR_UNAVAILABLE", "field": "ocr", "value": "OCR engine not installed"})
    artifact = {"width": res["width"], "height": res["height"], "inverted": res["inverted"], "lines": res["lines"],
                "screenshotChat": chat}
    return {"artifactType": "ocr", "artifact": artifact, "chunks": chunks, "metadata": meta, "flags": flags,
            "hashes": hashes, "children": []}


def _days(a: str, b: str) -> int:
    from datetime import date

    return (date.fromisoformat(a) - date.fromisoformat(b)).days


# ------------------------------------------------------------------ pdf
def extract_pdf(data: bytes) -> dict[str, Any]:
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    meta, flags = md.pdf_metadata(doc)
    chunks: list[dict[str, Any]] = []
    pages = []
    for pno, page in enumerate(doc, start=1):
        blocks = [b for b in page.get_text("blocks") if b[6] == 0 and b[4].strip()]
        text = "\n".join(b[4] for b in blocks)
        ocrd = False
        if len(text.strip()) >= 50:
            pages.append({"page": pno, "ocr": False, "chars": len(text)})
            for b in blocks:
                for p in _pdf_units(b[4]):
                    chunks.append({"idx": len(chunks), "text": p, "unit": "paragraph", "refTs": meta.get("createdAt"),
                                   "locator": {"page": pno, "bbox": [round(v, 1) for v in b[:4]]}, "ocr": False})
            continue
        if len(text.strip()) < 50:
            pix = page.get_pixmap(dpi=300)
            res = ocr.ocr_image(pix.pil_image() if hasattr(pix, "pil_image") else _pix_to_pil(pix))
            # Scale OCR boxes back to PDF points (72 dpi).
            scale = 72 / 300
            for ln in res["lines"]:
                ln["bbox"] = [round(v * scale, 1) for v in ln["bbox"]]
            text = "\n".join(ln["text"] for ln in res["lines"])
            ocrd = True
        pages.append({"page": pno, "ocr": ocrd, "chars": len(text)})
        for p in _paragraphs(text):
            chunks.append({"idx": len(chunks), "text": p, "unit": "paragraph", "refTs": meta.get("createdAt"),
                           "locator": {"page": pno}, "ocr": ocrd})
    meta["ocrPages"] = [p["page"] for p in pages if p["ocr"]]
    return {"artifactType": "pdf_text", "artifact": {"pages": pages}, "chunks": chunks, "metadata": meta,
            "flags": flags, "children": []}


_ROW_DATE = re.compile(r"^\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|^\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\b")


def _pdf_units(block_text: str) -> list[str]:
    """A text block → citable units. Lines that start with a date (statement/transaction rows) are their own unit."""
    lines = [ln.strip() for ln in block_text.splitlines() if ln.strip()]
    units: list[str] = []
    buf: list[str] = []
    for ln in lines:
        if _ROW_DATE.match(ln) and buf:
            units.append(" ".join(buf))
            buf = []
        buf.append(ln)
    if buf:
        units.append(" ".join(buf))
    out: list[str] = []
    for u in units:
        out.extend(_paragraphs(u))
    return out


def _pix_to_pil(pix):
    from PIL import Image

    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


# ------------------------------------------------------------------ email
def extract_email(data: bytes) -> dict[str, Any]:
    msg = email.message_from_bytes(data, policy=email.policy.default)
    headers = {k: str(msg.get(k)) for k in ("From", "To", "Cc", "Subject", "Date", "Message-ID", "Reply-To", "Return-Path") if msg.get(k)}
    try:
        sent = parsedate_to_datetime(msg["Date"]).isoformat() if msg["Date"] else None
    except (TypeError, ValueError):
        sent = None
    from_addr = getaddresses([headers.get("From", "")])
    sender = (from_addr[0][0] or from_addr[0][1]) if from_addr else None
    shown = ("From", "To", "Cc", "Subject", "Date")
    chunks = [{"idx": 0, "text": "\n".join(f"{k}: {v}" for k, v in headers.items() if k in shown), "unit": "header",
               "sender": sender, "refTs": sent, "locator": {"part": "headers"}}]
    body = msg.get_body(preferencelist=("plain", "html"))
    text = ""
    if body is not None:
        text = body.get_content()
        if body.get_content_type() == "text/html":
            text = re.sub(r"<[^>]+>", " ", re.sub(r"(?i)<br\s*/?>|</p>", "\n", text))
    for i, p in enumerate(_paragraphs(text)):
        chunks.append({"idx": len(chunks), "text": p, "unit": "paragraph", "sender": sender, "refTs": sent,
                       "locator": {"part": "body", "paragraphIdx": i}})
    children = []
    for part in msg.iter_attachments():
        payload = part.get_payload(decode=True) or b""
        if 0 < len(payload) <= MAX_CHILD_BYTES:
            children.append({"filename": part.get_filename() or "attachment", "data": base64.b64encode(payload).decode()})
    flags = []
    rp = headers.get("Return-Path", "")
    if rp and from_addr and from_addr[0][1] and from_addr[0][1].lower() not in rp.lower():
        flags.append({"type": "SENDER_MISMATCH", "field": "Return-Path", "value": f"From {from_addr[0][1]} vs Return-Path {rp}"})
    meta = {"from": headers.get("From"), "to": headers.get("To"), "subject": headers.get("Subject"), "sentAt": sent}
    return {"artifactType": "email_parsed", "artifact": {"headers": headers}, "chunks": chunks,
            "metadata": {k: v for k, v in meta.items() if v}, "flags": flags, "children": children}


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
