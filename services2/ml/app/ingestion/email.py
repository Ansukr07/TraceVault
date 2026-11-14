from __future__ import annotations

import base64
from email import policy
from email.parser import BytesParser
from typing import Any


def parse_eml(data: bytes) -> dict[str, Any]:
    message = BytesParser(policy=policy.default).parsebytes(data)
    headers = {key: str(message.get(key)) for key in ("From", "To", "Cc", "Bcc", "Date", "Subject", "Message-ID", "In-Reply-To", "References") if message.get(key)}
    bodies = []
    attachments = []
    for part_index, part in enumerate(message.walk()):
        if part.is_multipart() and part.get_content_type() != "message/rfc822":
            continue
        name = part.get_filename()
        payload = part.get_payload(decode=True)
        if payload is None and part.get_content_type() == "message/rfc822":
            nested = part.get_payload()
            content = (nested[0].as_bytes(policy=policy.default) if nested else b"")
        else:
            content = payload or b""
        content_type = part.get_content_type()
        if name or part.get_content_disposition() == "attachment":
            attachments.append({"filename": name or f"attachment-{part_index}", "mime": content_type, "size": len(content), "bytesBase64": base64.b64encode(content).decode("ascii"), "locator": {"part": part_index}, "childEvidence": True})
        elif content_type == "text/plain":
            charset = part.get_content_charset() or "utf-8"
            bodies.append(content.decode(charset, errors="replace"))
    return {"headers": headers, "body": "\n".join(bodies).strip(), "attachments": attachments, "warnings": []}
