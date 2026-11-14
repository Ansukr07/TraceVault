"""Email (.eml) ingestion (spec I6): headers, body paragraphs, attachments as child evidence."""
from __future__ import annotations

import base64
import email
import email.policy
import re
from email.utils import getaddresses, parsedate_to_datetime
from typing import Any

from .chunking import paragraphs

MAX_CHILD_BYTES = 50 * 1024 * 1024
HEADER_KEYS = ("From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "Reply-To", "Return-Path")


def _headers(msg) -> dict[str, str]:
    return {k: str(msg.get(k)) for k in HEADER_KEYS if msg.get(k)}


def _body_text(msg) -> str:
    body = msg.get_body(preferencelist=("plain", "html"))
    if body is None:
        return ""
    text = body.get_content()
    if body.get_content_type() == "text/html":
        text = re.sub(r"<[^>]+>", " ", re.sub(r"(?i)<br\s*/?>|</p>", "\n", text))
    return text


def _attachments(msg) -> list[tuple[str, str, bytes]]:
    """(filename, mime, bytes) for every attachment, including forwarded message/rfc822 parts."""
    out = []
    for i, part in enumerate(msg.iter_attachments()):
        payload = part.get_payload(decode=True)
        if payload is None and part.get_content_type() == "message/rfc822":
            nested = part.get_payload()
            payload = nested[0].as_bytes(policy=email.policy.default) if nested else b""
        out.append((part.get_filename() or f"attachment-{i}", part.get_content_type(), payload or b""))
    return out


def extract_email(data: bytes) -> dict[str, Any]:
    """Chunked extraction used by /extract."""
    msg = email.message_from_bytes(data, policy=email.policy.default)
    headers = _headers(msg)
    try:
        sent = parsedate_to_datetime(msg["Date"]).isoformat() if msg["Date"] else None
    except (TypeError, ValueError):
        sent = None
    from_addr = getaddresses([headers.get("From", "")])
    sender = (from_addr[0][0] or from_addr[0][1]) if from_addr else None
    shown = ("From", "To", "Cc", "Subject", "Date")
    chunks = [{"idx": 0, "text": "\n".join(f"{k}: {v}" for k, v in headers.items() if k in shown), "unit": "header",
               "sender": sender, "refTs": sent, "locator": {"part": "headers"}}]
    for i, p in enumerate(paragraphs(_body_text(msg))):
        chunks.append({"idx": len(chunks), "text": p, "unit": "paragraph", "sender": sender, "refTs": sent,
                       "locator": {"part": "body", "paragraphIdx": i}})
    children = [{"filename": name, "data": base64.b64encode(payload).decode()}
                for name, _mime, payload in _attachments(msg) if 0 < len(payload) <= MAX_CHILD_BYTES]
    flags = []
    rp = headers.get("Return-Path", "")
    if rp and from_addr and from_addr[0][1] and from_addr[0][1].lower() not in rp.lower():
        flags.append({"type": "SENDER_MISMATCH", "field": "Return-Path", "value": f"From {from_addr[0][1]} vs Return-Path {rp}"})
    meta = {"from": headers.get("From"), "to": headers.get("To"), "subject": headers.get("Subject"), "sentAt": sent}
    return {"artifactType": "email_parsed", "artifact": {"headers": headers}, "chunks": chunks,
            "metadata": {k: v for k, v in meta.items() if v}, "flags": flags, "children": children}


def parse_eml(data: bytes) -> dict[str, Any]:
    """Flat view used by /parse/eml: {headers, body, attachments[{filename,mime,size,bytesBase64}], warnings}."""
    msg = email.message_from_bytes(data, policy=email.policy.default)
    attachments = [{"filename": name, "mime": mime, "size": len(payload), "bytesBase64": base64.b64encode(payload).decode("ascii"),
                    "locator": {"part": i}, "childEvidence": True}
                   for i, (name, mime, payload) in enumerate(_attachments(msg))]
    return {"headers": _headers(msg), "body": _body_text(msg).strip(), "attachments": attachments, "warnings": []}
