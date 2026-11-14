import os

import pymupdf
from fastapi.testclient import TestClient


def client():
    os.environ["INTERNAL_SECRET"] = "s3cret"
    from app.main import app

    return TestClient(app, headers={"x-internal-secret": "s3cret"})


def test_report_pdf_paginates_stamps_and_embeds_indic_fonts():
    body = {
        "html": "<h1>Case</h1>" + "<p>Rahul sent ₹5,000 demand. कल रात नौ बजे फोरम मॉल। ನಾಳೆ ಹಣ ಕಳುಹಿಸು</p>" * 120,
        "footer": "Viewed by lawyer@example.com · Case 123",
        "header": "TraceVault",
    }
    r = client().post("/report/pdf", json=body)
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    doc = pymupdf.open(stream=r.content, filetype="pdf")
    assert doc.page_count >= 2
    for page in doc:  # the viewer watermark is on every page (spec H5)
        assert "Viewed by lawyer@example.com" in page.get_text()
    fonts = {f[3] for page in doc for f in page.get_fonts()}
    assert any("Devanagari" in f for f in fonts) and any("Kannada" in f for f in fonts), fonts
    assert doc.metadata["title"] == "TraceVault report"


def test_report_requires_internal_secret():
    r = TestClient(client().app).post("/report/pdf", json={"html": "<p>x</p>"})
    assert r.status_code == 403
