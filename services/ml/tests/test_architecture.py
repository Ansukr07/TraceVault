"""Ingestion views, OCR routing, merged /nlp/enrich, System1, and the investigation agents."""
import asyncio
import json
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

os.environ.setdefault("INTERNAL_SECRET", "test-secret")
H = {"x-internal-secret": os.environ["INTERNAL_SECRET"]}

WA = "12/05/24, 9:41 pm - Rahul: send 15000 to rahul@ybl\n12/05/24, 9:42 pm - Me: ok\nsecond line\n"


@pytest.fixture(scope="module")
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture
def fake_system1(monkeypatch):
    """Stub the Laya runtime: financial labels score high, the rest low."""
    from app.models import system1 as s1

    scores = {"harassment": 0.1, "financial_fraud": 0.9, "scams": 0.2, "upi_bank_fraud": 0.8}
    monkeypatch.setattr(s1.system1, "_answers", lambda text, allow_hosted=True: ("laya", {k: {"noul": v} for k, v in scores.items()}))
    monkeypatch.setenv("LAYA_CALIBRATION_VALIDATED", "true")
    return s1.system1


def ctx(**extra):
    base = {
        "caseId": "c1", "scopeFiltered": True,
        "evidence": [{"id": "e1", "kind": "chat_export", "filename": "chat.txt", "capturedAt": "2024-05-12"}],
        "chunks": [{"id": "k1", "evidenceId": "e1", "text": "Rahul asked me to send 15000 to rahul@ybl for a job fee"}],
        "entities": [{"id": "p1", "type": "Person", "name": "Rahul", "chunkIds": ["k1"]}],
        "events": [{"id": "v1", "title": "Payment request", "timestamp": "2024-05-12T21:41:00", "entityIds": ["p1"], "evidenceChunkIds": ["k1"], "amount": 15000}],
    }
    base.update(extra)
    return base


# ------------------------------------------------------------------ ingestion views
def test_whatsapp_message_view_and_date_order_override():
    from app.ingestion.whatsapp import parse

    out = parse(WA)
    assert out["format"] == "whatsapp_export" and out["dateOrder"] == "DMY"
    assert [m["sender"] for m in out["messages"]] == ["Rahul", "Me"]
    assert out["messages"][1]["text"] == "ok\nsecond line" and out["warnings"]  # 12/05 is ambiguous
    assert parse(WA, "MDY")["messages"][0]["timestamp"].startswith("2024-12-05")


def test_telegram_json_view():
    from app.ingestion.chat_exports import parse_json_text

    doc = {"messages": [{"id": 1, "type": "message", "date": "2024-05-12T21:41:00", "from": "Rahul", "text": "hi"}]}
    out = parse_json_text(json.dumps(doc), "telegram")
    assert out["format"] == "telegram_json" and out["messages"][0]["sender"] == "Rahul"
    with pytest.raises(ValueError):
        parse_json_text("{bad", "telegram")


def test_eml_flat_view_keeps_attachments():
    from app.ingestion.email import extract_email, parse_eml

    raw = (b"From: A <a@x.com>\r\nTo: b@y.com\r\nSubject: hi\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n"
           b"--b\r\nContent-Type: text/plain\r\n\r\nPay now\r\n--b\r\nContent-Type: application/octet-stream\r\n"
           b"Content-Disposition: attachment; filename=r.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n--b--\r\n")
    flat = parse_eml(raw)
    assert flat["body"] == "Pay now" and flat["attachments"][0]["filename"] == "r.bin" and flat["attachments"][0]["size"] == 3
    assert extract_email(raw)["children"][0]["filename"] == "r.bin"


def test_parse_routes(client):
    r = client.post("/parse/whatsapp", headers=H, files={"file": ("chat.txt", WA.encode())})
    assert r.status_code == 200 and len(r.json()["messages"]) == 2
    r = client.post("/metadata", headers=H, files={"file": ("a.eml", b"From: a@x.com\r\nSubject: s\r\n\r\nbody")})
    assert r.json()["email"]["from"] == "a@x.com"


# ------------------------------------------------------------------ OCR routing
def test_sarvam_provider_without_geometry_becomes_text_lines(monkeypatch):
    from app.ocr import english, indic, pipeline

    monkeypatch.setattr(english, "available", lambda: False)
    monkeypatch.setattr(indic, "sarvam_ocr", lambda img, usage: {"lines": [{"text": "ಹಣ ಕಳುಹಿಸಿ", "bbox": None, "conf": 0.55}]})
    res = pipeline.ocr_image(Image.new("RGB", (100, 50), "white"), provider="sarvam")
    assert res["provider"] == "sarvam_vision" and res["lines"] == [] and res["textLines"][0]["text"] == "ಹಣ ಕಳುಹಿಸಿ"


# ------------------------------------------------------------------ NLP
def test_enrich_returns_both_contracts(client, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    body = {"chunks": [{"id": "k1", "text": "send 15000 to rahul@ybl on 12 May at 9pm", "refTs": "2024-05-14T10:00:00"}]}
    out = client.post("/nlp/enrich", headers=H, json=body).json()
    assert out["items"][0]["id"] == "k1" and "severity" in out["items"][0]
    assert {m["label"] for m in out["mentions"]} >= {"UPI_ID", "MONEY"}
    assert out["times"] and out["times"][0]["tsPrecision"] in ("exact", "approx")
    assert out["indexedChunks"] == 0 and out["embeddings"] == {} and out["workingTexts"]["k1"].startswith("send")


def test_enrich_does_not_send_text_to_hosted_system1_by_default(client, monkeypatch):
    from app.models import system1 as s1

    monkeypatch.setenv("HF_TOKEN", "hf_x")
    called = []
    monkeypatch.setattr(s1.system1, "classify", lambda *a, **k: called.append(a))
    client.post("/nlp/enrich", headers=H, json={"chunks": [{"id": "k1", "text": "hello"}]})
    assert called == []


# ------------------------------------------------------------------ System1
def test_system1_uncalibrated_abstains(monkeypatch, fake_system1):
    monkeypatch.setenv("LAYA_CALIBRATION_VALIDATED", "false")
    r = fake_system1.classify("text")
    assert r.labels == [] and r.primary == "other" and r.needs_owner_review and r.scores["financial_fraud"] == 0.9


def test_system1_calibrated_labels(fake_system1):
    r = fake_system1.classify("text")
    assert r.labels == ["financial_fraud", "upi_bank_fraud"] and r.primary == "financial_fraud" and not r.needs_owner_review


def test_system1_unavailable_falls_back_to_other(monkeypatch):
    from app.models.system1 import System1

    monkeypatch.delenv("HF_TOKEN", raising=False)
    s = System1()
    s._error = "not installed"
    r = s.classify("hello")
    assert r.primary == "other" and r.provider == "unavailable" and r.needs_owner_review


def test_incident_classify_route(client, fake_system1):
    r = client.post("/incident/classify", headers=H, json={"textEn": "asked for money"})
    assert r.status_code == 200 and r.json()["labels"] == ["financial_fraud", "upi_bank_fraud"]


# ------------------------------------------------------------------ agents
def test_agents_require_scoped_snapshot(client):
    r = client.post("/agents/run", headers=H, json={"caseCtx": {"caseId": "c1"}})
    assert r.status_code == 422


def test_run_agents_async_keeps_order_and_isolates_failures():
    from app.agents.runner import run_agents_async

    names = ["report_generation", "knowledge_graph", "evidence_gap", "financial_investigation", "investigation_replay"]
    out = asyncio.run(run_agents_async(ctx(), names))
    assert [c["agent"] for c in out["checkpoints"]] == names and list(out["results"]) == names
    assert out["status"] == "completed"
    assert out["results"]["investigation_replay"]["items"][0]["id"] == "v1"
    assert out["results"]["financial_investigation"]["unmatchedPaymentEventIds"] == ["v1"]


def test_investigate_uses_system1_labels_and_reviews(client, fake_system1):
    out = client.post("/agents/investigate", headers=H, json={"caseCtx": ctx(), "objective": "Explain the payment"}).json()
    assert out["system1"]["labels"] == ["financial_fraud", "upi_bank_fraud"]
    assert "financial_investigation" in out["plan"]["selectedAgents"]
    assert out["plan"]["incidentLabels"] == ["financial_fraud", "upi_bank_fraud"]
    assert out["results"]["evidence_gap"]["evaluatedIncidentTypes"] == ["financial_fraud", "upi_bank_fraud"]
    review = out["system1Review"]
    assert review["status"] == "reviewed" and review["advisory"] is True


def test_caller_labels_are_never_overridden(fake_system1):
    from app.agents.runner import with_system1_labels

    given, routed = with_system1_labels(ctx(incidentType="harassment"))
    assert given["incidentType"] == "harassment" and "incidentLabels" not in given and routed["labels"]
    review = fake_system1.review(given, {})
    assert {f["code"] for f in review["flags"]} >= {"LABELS_NOT_DECLARED", "LABELS_NOT_INDICATED"}


def test_system1_local_only_never_calls_hosted(monkeypatch):
    from app.models.system1 import System1

    monkeypatch.setenv("HF_TOKEN", "hf_x")
    s = System1()
    s._load_hf_client = lambda: (_ for _ in ()).throw(AssertionError("hosted client used"))
    s._error = "not installed"  # local runtime absent → clean 'unavailable', but no hosted call
    r = s.classify("hello", allow_hosted=False)
    assert r.provider == "unavailable"
