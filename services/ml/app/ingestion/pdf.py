"""PDF ingestion (spec I5): text layer per block, 300-DPI OCR for pages with < 50 text characters."""
from __future__ import annotations

import re
from typing import Any

from ..ocr.pipeline import ocr_image
from . import metadata as md
from .chunking import paragraphs

OCR_DPI = 300
MIN_TEXT_CHARS = 50
_ROW_DATE = re.compile(r"^\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|^\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\b")


def _open(data: bytes):
    import pymupdf

    try:
        return pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid or unreadable PDF") from exc


def _page_image(page):
    pix = page.get_pixmap(dpi=OCR_DPI)
    if hasattr(pix, "pil_image"):
        return pix.pil_image()
    from PIL import Image

    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _ocr_page(page, provider: str) -> dict[str, Any]:
    res = ocr_image(_page_image(page), provider=provider)
    scale = 72 / OCR_DPI  # OCR boxes back to PDF points
    for ln in res["lines"]:
        ln["bbox"] = [round(v * scale, 1) for v in ln["bbox"]]
    return res


def extract_pdf(data: bytes, ocr_provider: str = "local") -> dict[str, Any]:
    """Chunked extraction used by /extract."""
    doc = _open(data)
    meta, flags = md.pdf_metadata(doc)
    chunks: list[dict[str, Any]] = []
    pages = []
    for pno, page in enumerate(doc, start=1):
        blocks = [b for b in page.get_text("blocks") if b[6] == 0 and b[4].strip()]
        text = "\n".join(b[4] for b in blocks)
        if len(text.strip()) >= MIN_TEXT_CHARS:
            pages.append({"page": pno, "ocr": False, "chars": len(text)})
            for b in blocks:
                for p in pdf_units(b[4]):
                    chunks.append({"idx": len(chunks), "text": p, "unit": "paragraph", "refTs": meta.get("createdAt"),
                                   "locator": {"page": pno, "bbox": [round(v, 1) for v in b[:4]]}, "ocr": False})
            continue
        res = _ocr_page(page, ocr_provider)
        text = "\n".join(ln["text"] for ln in res["lines"] + res.get("textLines", []))
        pages.append({"page": pno, "ocr": True, "chars": len(text), "ocrProvider": res.get("provider")})
        for p in paragraphs(text):
            chunks.append({"idx": len(chunks), "text": p, "unit": "paragraph", "refTs": meta.get("createdAt"),
                           "locator": {"page": pno}, "ocr": True})
    meta["ocrPages"] = [p["page"] for p in pages if p["ocr"]]
    return {"artifactType": "pdf_text", "artifact": {"pages": pages}, "chunks": chunks, "metadata": meta,
            "flags": flags, "children": []}


def parse_pdf(data: bytes, ocr_provider: str = "auto") -> dict[str, Any]:
    """Page-level view used by /parse/pdf: {pages:[{page,text,ocrUsed,lines}], metadata, warnings}."""
    doc = _open(data)
    pages, warnings = [], []
    for pno, page in enumerate(doc, start=1):
        text = page.get_text("text") or ""
        record = {"page": pno, "text": text, "ocrUsed": False, "lines": []}
        if len(text.strip()) < MIN_TEXT_CHARS:
            res = _ocr_page(page, ocr_provider)
            lines = res["lines"] + res.get("textLines", [])
            record.update(ocrUsed=True, lines=lines, text="\n".join(ln["text"] for ln in lines), ocrProvider=res.get("provider"))
            if res.get("unavailable"):
                warnings.append("OCR engine unavailable for scanned pages.")
        pages.append(record)
    meta = {k: doc.metadata.get(k) for k in ("title", "author", "subject", "creator", "producer", "creationDate", "modDate") if doc.metadata.get(k)}
    return {"pages": pages, "metadata": meta, "warnings": list(dict.fromkeys(warnings))}


def pdf_units(block_text: str) -> list[str]:
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
        out.extend(paragraphs(u))
    return out
