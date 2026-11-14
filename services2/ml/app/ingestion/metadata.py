from __future__ import annotations

import io
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from typing import Any


def extract_metadata(data: bytes, filename: str, mime: str | None = None, uploaded_at: str | None = None, file_times: dict[str, str] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"filename": filename, "mime": mime, "size": len(data), "uploadTime": uploaded_at or datetime.now(timezone.utc).isoformat(), "fileTimes": file_times or {}, "warnings": []}
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(data))
        exif = image.getexif()
        if exif:
            from PIL.ExifTags import TAGS, GPSTAGS
            values = {TAGS.get(k, str(k)): v for k, v in exif.items()}
            result["exif"] = {k: str(v) for k, v in values.items() if k not in {"GPSInfo"}}
            gps = exif.get_ifd(34853) if 34853 in exif else None
            if gps:
                result["gps"] = {GPSTAGS.get(k, str(k)): str(v) for k, v in gps.items()}
    except Exception:
        pass
    if (mime or "").lower() == "application/pdf" or filename.lower().endswith(".pdf"):
        try:
            import fitz
            doc = fitz.open(stream=data, filetype="pdf")
            result["pdf"] = {key: doc.metadata.get(key) for key in ("title", "author", "creator", "producer", "creationDate", "modDate") if doc.metadata.get(key)}
        except Exception as exc:
            result["warnings"].append(f"PDF metadata unavailable: {exc}")
    if (mime or "").lower() in {"message/rfc822", "application/octet-stream"} and filename.lower().endswith(".eml"):
        try:
            message = BytesParser(policy=policy.default).parsebytes(data)
            result["email"] = {key.lower(): str(message.get(key)) for key in ("From", "To", "Date", "Subject", "Message-ID") if message.get(key)}
        except Exception as exc:
            result["warnings"].append(f"Email headers unavailable: {exc}")
    return result
