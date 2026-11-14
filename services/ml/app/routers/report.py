"""POST /report/pdf — HTML → PDF with PyMuPDF's Story engine (spec R1, R3, R4).

PyMuPDF replaces Puppeteer here: no Chromium download, and MuPDF falls back to embedded Noto fonts, so Hindi and
Kannada transcripts render. The Story engine supports a CSS subset (tables, headings, colours, borders), which the
Node report template sticks to. Every page gets a footer with the watermark and page numbers (spec H5).
"""
from __future__ import annotations

import asyncio

import pymupdf
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field

router = APIRouter()
PAGE = pymupdf.paper_rect("a4")
MARGIN = (46, 54, -46, -62)  # left, top, right, bottom


class PdfIn(BaseModel):
    html: str = Field(max_length=8_000_000)
    title: str = "TraceVault report"
    footer: str = ""  # watermark: "Viewed by … · Case …"
    header: str = ""


def render(body: PdfIn) -> bytes:
    story = pymupdf.Story(body.html)
    buf = pymupdf.Document()  # in-memory result
    from io import BytesIO

    out = BytesIO()
    writer = pymupdf.DocumentWriter(out)
    where = PAGE + MARGIN
    more = 1
    while more:
        dev = writer.begin_page(PAGE)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    del buf
    doc = pymupdf.open(stream=out.getvalue(), filetype="pdf")
    n = doc.page_count
    for i, page in enumerate(doc, start=1):
        if body.header:
            page.insert_text((MARGIN[0], 30), body.header, fontsize=8, color=(0.45, 0.45, 0.43))
        foot = body.footer
        page.insert_text((MARGIN[0], PAGE.height - 30), foot[:140], fontsize=7.5, color=(0.45, 0.45, 0.43))
        label = f"Page {i} of {n}"
        page.insert_text((PAGE.width + MARGIN[2] - pymupdf.get_text_length(label, fontsize=7.5), PAGE.height - 30), label, fontsize=7.5, color=(0.45, 0.45, 0.43))
    doc.set_metadata({"title": body.title, "producer": "TraceVault report builder (PyMuPDF)", "creator": "TraceVault"})
    data = doc.tobytes(deflate=True, garbage=3)
    doc.close()
    return data


@router.post("/report/pdf")
async def report_pdf(body: PdfIn):
    data = await asyncio.to_thread(render, body)
    return Response(content=data, media_type="application/pdf")
