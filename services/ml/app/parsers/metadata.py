"""Metadata extraction (spec I7) and edit red flags (feeds X1 EDITED_FILE / METADATA_MISMATCH)."""
from __future__ import annotations

import io
import re
from datetime import datetime
from typing import Any

EDITING_SOFTWARE = re.compile(
    r"snapseed|photoshop|lightroom|picsart|gimp|canva|pixlr|facetune|affinity|paint\.net|inshot|"
    r"remini|fotor|illustrator|ilovepdf|smallpdf|sejda|pdfescape|foxit phantom|acrobat pro|libreoffice",
    re.IGNORECASE,
)


def _exif_dt(v: str | None) -> str | None:
    if not v:
        return None
    try:
        return datetime.strptime(str(v).strip()[:19], "%Y:%m:%d %H:%M:%S").isoformat()
    except ValueError:
        return None


def _gps(gps: dict) -> dict | None:
    try:
        def deg(vals, ref):
            d, m, s = (float(x) for x in vals)
            v = d + m / 60 + s / 3600
            return -v if ref in ("S", "W") else v

        return {"lat": round(deg(gps[2], gps[1]), 6), "lon": round(deg(gps[4], gps[3]), 6)}
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None


def image_metadata(data: bytes) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    from PIL import ExifTags, Image

    img = Image.open(io.BytesIO(data))
    meta: dict[str, Any] = {"width": img.width, "height": img.height, "format": img.format}
    flags: list[dict[str, Any]] = []
    exif = img.getexif()
    if exif:
        tags = {ExifTags.TAGS.get(k, str(k)): v for k, v in exif.items()}
        try:
            sub = exif.get_ifd(0x8769)
            tags.update({ExifTags.TAGS.get(k, str(k)): v for k, v in sub.items()})
        except Exception:  # noqa: BLE001  (malformed sub-IFD)
            pass
        meta.update({
            "captureTime": _exif_dt(tags.get("DateTimeOriginal") or tags.get("DateTimeDigitized")),
            "modifyTime": _exif_dt(tags.get("DateTime")),
            "make": str(tags.get("Make", "")).strip("\x00 ") or None,
            "model": str(tags.get("Model", "")).strip("\x00 ") or None,
            "software": str(tags.get("Software", "")).strip("\x00 ") or None,
        })
        try:
            g = exif.get_ifd(0x8825)
            if g:
                meta["gps"] = _gps(dict(g))
        except Exception:  # noqa: BLE001
            pass
    sw = meta.get("software")
    if sw and EDITING_SOFTWARE.search(sw):
        flags.append({"type": "EDITED_FILE", "field": "Software", "value": sw})
    ct, mt = meta.get("captureTime"), meta.get("modifyTime")
    if ct and mt and abs((datetime.fromisoformat(mt) - datetime.fromisoformat(ct)).total_seconds()) > 3600:
        flags.append({"type": "METADATA_MISMATCH", "field": "DateTime", "value": f"captured {ct}, modified {mt}"})
    return {k: v for k, v in meta.items() if v is not None}, flags


def _pdf_dt(v: str | None) -> str | None:
    m = re.match(r"D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?", v or "")
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x or 0) for x in m.groups())
    try:
        return datetime(y, mo, d, h, mi, s).isoformat()
    except ValueError:
        return None


def pdf_metadata(doc) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    md = doc.metadata or {}
    meta = {
        "pages": doc.page_count,
        "title": md.get("title") or None,
        "author": md.get("author") or None,
        "creator": md.get("creator") or None,
        "producer": md.get("producer") or None,
        "createdAt": _pdf_dt(md.get("creationDate")),
        "modifiedAt": _pdf_dt(md.get("modDate")),
    }
    flags = []
    for f in ("creator", "producer"):
        if meta[f] and EDITING_SOFTWARE.search(meta[f]):
            flags.append({"type": "EDITED_FILE", "field": f, "value": meta[f]})
    if meta["createdAt"] and meta["modifiedAt"]:
        gap = (datetime.fromisoformat(meta["modifiedAt"]) - datetime.fromisoformat(meta["createdAt"])).total_seconds()
        if gap > 7 * 86400:  # copy/export/re-save routinely moves ModDate by days; only large gaps matter (spec §4.5)
            flags.append({"type": "METADATA_MISMATCH", "field": "ModDate", "value": f"created {meta['createdAt']}, modified {meta['modifiedAt']}"})
    return {k: v for k, v in meta.items() if v is not None}, flags


def image_hashes(data: bytes) -> dict[str, str]:
    import imagehash
    from PIL import Image

    img = Image.open(io.BytesIO(data)).convert("RGB")
    return {"phash": str(imagehash.phash(img)), "dhash": str(imagehash.dhash(img))}
