from __future__ import annotations

import io
from typing import Any

from app.ocr.pipeline import OCRPipeline


def parse_pdf(data: bytes, ocr: OCRPipeline) -> dict[str, Any]:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required for PDF extraction") from exc
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ValueError("Invalid or unreadable PDF") from exc
    pages = []
    warnings = []
    for page_index, page in enumerate(document):
        text = page.get_text("text") or ""
        page_record = {"page": page_index + 1, "text": text, "ocrUsed": False, "lines": []}
        if len(text.strip()) < 50:
            pix = page.get_pixmap(dpi=300, alpha=False)
            image = pix.tobytes("png")
            response = ocr.extract(image)
            page_record["ocrUsed"] = True
            page_record["lines"] = [line.model_dump() for line in response.lines]
            page_record["text"] = "\n".join(line.text for line in response.lines)
            warnings.extend(response.warnings)
        pages.append(page_record)
    metadata = {key: document.metadata.get(key) for key in ("title", "author", "subject", "creator", "producer", "creationDate", "modDate") if document.metadata.get(key)}
    return {"pages": pages, "metadata": metadata, "warnings": list(dict.fromkeys(warnings))}
