"""Google Cloud translation + Vision OCR (official APIs, mocked transports: no network, no key needed)."""
import asyncio
import json

import httpx
import pytest
from PIL import Image

from app.lang import google_cloud as gc
from app.lang.google_cloud import GoogleCloud, GoogleError, parse_vision, to_google_lang
from app.lang.translate import annotate_chunks, pick_provider
from app.parsers import ocr
from app.voice.sarvam_client import SarvamClient, SarvamConfig, UsageLog

KEY = "AIza-test-secret-key"
KANNADA = "ನಾನು ನಿನ್ನನ್ನು ಬಿಡುವುದಿಲ್ಲ"  # "I will not leave you" (synthetic)


def sarvam_off() -> SarvamClient:
    return SarvamClient(SarvamConfig(api_key="", mock=False))


def translate_transport(seen: list, fail: int | None = None):
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        seen.append({"url": str(req.url), "key": req.url.params.get("key"), "body": body})
        if fail:
            return httpx.Response(fail, json={"error": {"message": "API key not valid" if fail == 403 else "quota"}})
        out = []
        for q in body["q"]:
            # Echo the placeholders untouched, as a real model does, and "translate" the Kannada.
            out.append({"translatedText": q.replace(KANNADA, "I will not leave you"), "detectedSourceLanguage": body.get("source", "kn")})
        return httpx.Response(200, json={"data": {"translations": out}})

    return httpx.MockTransport(handler)


def vision_response(lines: list[tuple[str, list[int]]], lang="kn") -> dict:
    """Build a Vision fullTextAnnotation: one block/paragraph, one word per line, last symbol carries LINE_BREAK."""
    words = []
    for text, (x0, y0, x1, y1) in lines:
        syms = [{"text": ch} for ch in text]
        syms[-1]["property"] = {"detectedBreak": {"type": "LINE_BREAK"}}
        words.append({"boundingBox": {"vertices": [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}]}, "confidence": 0.96, "symbols": syms})
    return {"fullTextAnnotation": {"text": "\n".join(t for t, _ in lines), "pages": [{
        "property": {"detectedLanguages": [{"languageCode": lang, "confidence": 0.97}]},
        "blocks": [{"paragraphs": [{"words": words}]}]}]}}


def vision_transport(seen: list, resp: dict):
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"responses": [resp]})

    return httpx.MockTransport(handler)


# ------------------------------------------------------------------ helpers
def test_language_code_mapping():
    assert to_google_lang("kn-IN") == "kn"
    assert to_google_lang("hi-IN") == "hi"
    assert to_google_lang("od-IN") == "or"  # Odia
    assert to_google_lang("hi-Latn") is None  # romanized text can't be a source language
    assert to_google_lang("auto") is None and to_google_lang(None) is None


def test_parse_vision_builds_lines_with_boxes_and_language():
    r = parse_vision(vision_response([(KANNADA, [10, 20, 300, 60]), ("ಹಣ ಕಳುಹಿಸು", [10, 80, 220, 120])]))
    assert [ln["text"] for ln in r["lines"]] == [KANNADA, "ಹಣ ಕಳುಹಿಸು"]
    assert r["lines"][0]["bbox"] == [10, 20, 300, 60]
    assert r["lines"][0]["conf"] == 0.96
    assert r["lang"] == "kn"
    assert r["text"].count("\n") == 1


def test_parse_vision_empty_page_is_empty_not_an_error():
    assert parse_vision({})["lines"] == []


# ------------------------------------------------------------------ translation
def test_translate_sends_source_target_and_key_and_records_usage():
    seen: list = []
    g = GoogleCloud(KEY, async_transport=translate_transport(seen))
    u = UsageLog()
    text, det = asyncio.run(g.translate(KANNADA, "kn-IN", usage=u))
    assert text == "I will not leave you" and det == "kn"
    assert seen[0]["key"] == KEY
    assert seen[0]["body"] == {"q": [KANNADA], "target": "en", "format": "text", "source": "kn"}
    assert u.records[0]["provider"] == "google" and u.records[0]["chars"] == len(KANNADA)


def test_translate_errors_never_leak_the_key():
    g = GoogleCloud(KEY, async_transport=translate_transport([], fail=403))
    with pytest.raises(GoogleError) as e:
        asyncio.run(g.translate(KANNADA, "kn-IN"))
    assert "403" in str(e.value) and "API key not valid" in str(e.value)
    assert KEY not in str(e.value)  # we never add the key to errors


def test_translate_without_a_key_fails_clearly():
    with pytest.raises(GoogleError, match="GOOGLE_API_KEY"):
        asyncio.run(GoogleCloud("").translate("x", "kn-IN"))


def test_provider_selection(monkeypatch):
    on, off = GoogleCloud(KEY), GoogleCloud("")
    monkeypatch.delenv("TRANSLATE_PROVIDER", raising=False)
    assert pick_provider(sarvam_off(), on) == "google"  # no Sarvam -> Google
    assert pick_provider(sarvam_off(), off) is None
    assert pick_provider(SarvamClient(SarvamConfig(api_key="s")), on) == "sarvam"  # Sarvam preferred in auto
    monkeypatch.setenv("TRANSLATE_PROVIDER", "google")
    assert pick_provider(SarvamClient(SarvamConfig(api_key="s")), on) == "google"
    monkeypatch.setenv("TRANSLATE_PROVIDER", "sarvam")
    assert pick_provider(sarvam_off(), on) is None  # forced to a provider that isn't available


def test_kannada_chunk_gets_english_working_copy_via_google(monkeypatch):
    monkeypatch.delenv("TRANSLATE_PROVIDER", raising=False)
    seen: list = []
    chunks = [{"text": KANNADA, "unit": "bubble"}, {"text": "see you at 9", "unit": "bubble"}]
    u = UsageLog()
    asyncio.run(annotate_chunks(chunks, client=sarvam_off(), mode="sarvam", usage=u, google=GoogleCloud(KEY, async_transport=translate_transport(seen))))
    assert chunks[0]["lang"] == "kn-IN"
    assert chunks[0]["textEn"] == "I will not leave you"
    assert chunks[0]["translation"] == {"provider": "google", "model": "nmt", "redacted": False}
    assert chunks[1]["textEn"] == "see you at 9" and len(seen) == 1  # English is never sent to Google


def test_redacted_mode_hides_phone_numbers_from_google(monkeypatch):
    monkeypatch.delenv("TRANSLATE_PROVIDER", raising=False)
    seen: list = []
    text = f"{KANNADA} +91 98450 01234"
    chunks = [{"text": text, "unit": "bubble"}]
    asyncio.run(annotate_chunks(chunks, client=sarvam_off(), mode="sarvam_redacted", usage=UsageLog(), google=GoogleCloud(KEY, async_transport=translate_transport(seen))))
    sent = seen[0]["body"]["q"][0]
    assert "98450" not in sent and "⟦PHONE_1⟧" in sent  # Google never saw the number
    assert chunks[0]["textEn"] == "I will not leave you +91 98450 01234"  # restored locally
    assert chunks[0]["translation"]["redacted"] is True


def test_translation_off_sends_nothing(monkeypatch):
    seen: list = []
    chunks = [{"text": KANNADA, "unit": "bubble"}]
    asyncio.run(annotate_chunks(chunks, client=sarvam_off(), mode="off", usage=UsageLog(), google=GoogleCloud(KEY, async_transport=translate_transport(seen))))
    assert seen == [] and "textEn" not in chunks[0]


def test_translation_failure_is_recorded_not_raised(monkeypatch):
    monkeypatch.delenv("TRANSLATE_PROVIDER", raising=False)
    chunks = [{"text": KANNADA, "unit": "bubble"}]
    asyncio.run(annotate_chunks(chunks, client=sarvam_off(), mode="sarvam", usage=UsageLog(), google=GoogleCloud(KEY, async_transport=translate_transport([], fail=429))))
    assert "textEn" not in chunks[0] and "429" in chunks[0]["translationError"]


# ------------------------------------------------------------------ OCR
@pytest.fixture
def blank():
    return Image.new("RGB", (400, 200), "white")


def patch_google(monkeypatch, seen, resp):
    g = GoogleCloud(KEY, transport=vision_transport(seen, resp))
    monkeypatch.setattr(gc, "_client", g)
    return g


def test_local_provider_never_contacts_google(monkeypatch, blank):
    seen: list = []
    patch_google(monkeypatch, seen, vision_response([(KANNADA, [0, 0, 5, 5])]))
    r = ocr.ocr_image(blank, provider="local")
    assert seen == []  # the default: images stay on this machine
    assert r["provider"] in ("rapidocr", None)


def test_google_provider_reads_kannada_lines(monkeypatch, blank):
    seen: list = []
    patch_google(monkeypatch, seen, vision_response([(KANNADA, [10, 20, 300, 60])]))
    r = ocr.ocr_image(blank, provider="google")
    assert r["provider"] == "google_vision"
    assert [ln["text"] for ln in r["lines"]] == [KANNADA]
    assert seen[0]["requests"][0]["imageContext"]["languageHints"] == ["kn", "hi", "en"]
    assert seen[0]["requests"][0]["features"] == [{"type": "DOCUMENT_TEXT_DETECTION"}]
    assert r["usage"][0]["endpoint"] == "vision_ocr"


def test_auto_uses_google_only_when_local_result_is_poor(monkeypatch, blank):
    seen: list = []
    patch_google(monkeypatch, seen, vision_response([(KANNADA, [10, 20, 300, 60])]))
    r = ocr.ocr_image(blank, provider="auto")  # a blank image: local finds nothing -> poor
    assert r["provider"] == "google_vision" and len(seen) == 1
    # Good local text must not be sent anywhere.
    seen.clear()
    monkeypatch.setattr(ocr, "_run", lambda img: [{"text": "Please do not do this", "bbox": [0, 0, 100, 20], "conf": 0.97}])
    monkeypatch.setattr(ocr, "available", lambda: True)
    r = ocr.ocr_image(blank, provider="auto")
    assert r["provider"] == "rapidocr" and seen == []


def test_poor_detection_flags_cjk_junk_and_low_confidence():
    junk = [{"text": "的一是不了人我在", "bbox": [0, 0, 1, 1], "conf": 0.9}]
    low = [{"text": "abc", "bbox": [0, 0, 1, 1], "conf": 0.3}]
    good = [{"text": "Hello there", "bbox": [0, 0, 1, 1], "conf": 0.95}]
    assert ocr._is_poor(junk) and ocr._is_poor(low) and ocr._is_poor([])
    assert not ocr._is_poor(good)


def test_google_ocr_failure_falls_back_to_local(monkeypatch, blank):
    g = GoogleCloud(KEY, transport=httpx.MockTransport(lambda r: httpx.Response(500, json={"error": {"message": "boom"}})))
    monkeypatch.setattr(gc, "_client", g)
    r = ocr.ocr_image(blank, provider="google")
    assert r["provider"] != "google_vision"  # fell back, did not raise
    assert r["usage"][0]["status"] == "error" and "500" in r["usage"][0]["error"]


def test_no_key_means_auto_stays_local(monkeypatch, blank):
    monkeypatch.setattr(gc, "_client", GoogleCloud(""))
    r = ocr.ocr_image(blank, provider="auto")
    assert r["provider"] != "google_vision" and r["usage"] == []


# ------------------------------------------------------------------ end to end through /extract
def _png(w=1080, h=900) -> bytes:
    import io

    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    return buf.getvalue()


def _client(monkeypatch, google: GoogleCloud):
    from fastapi.testclient import TestClient

    from app import main as api
    from app.routers import extract as route

    monkeypatch.setenv("INTERNAL_SECRET", "s3cret")
    monkeypatch.delenv("TRANSLATE_PROVIDER", raising=False)
    monkeypatch.setattr(gc, "_client", google)
    monkeypatch.setattr(route, "get_client", sarvam_off)  # no Sarvam: Google must carry translation
    return TestClient(api.app, headers={"x-internal-secret": "s3cret"})


def _both(seen: dict):
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        if "vision" in req.url.host:
            seen["vision"] = body
            return httpx.Response(200, json={"responses": [vision_response([(KANNADA, [60, 100, 900, 160])])]})
        seen["translate"] = body
        return httpx.Response(200, json={"data": {"translations": [{"translatedText": q.replace(KANNADA, "I will not leave you"), "detectedSourceLanguage": "kn"} for q in body["q"]]}})

    return httpx.MockTransport(handler)


def test_kannada_screenshot_is_read_and_translated_end_to_end(monkeypatch):
    seen: dict = {}
    t = _both(seen)
    with _client(monkeypatch, GoogleCloud(KEY, transport=t, async_transport=t)) as c:
        r = c.post("/extract", files={"file": ("kn.png", _png(), "image/png")},
                   data={"kind": "image", "filename": "kn.png", "translateMode": "sarvam_redacted", "ocrProvider": "auto"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["artifact"]["ocrProvider"] == "google_vision" and out["metadata"]["ocrProvider"] == "google_vision"
    texts = [ch["text"] for ch in out["chunks"]]
    assert any(KANNADA in x for x in texts)
    ch = next(ch for ch in out["chunks"] if KANNADA in ch["text"])
    assert ch["lang"] == "kn-IN"
    assert ch["textEn"] == "I will not leave you"
    assert ch["translation"]["provider"] == "google"
    endpoints = {(u["provider"], u["endpoint"]) for u in out["usage"]}
    assert ("google", "vision_ocr") in endpoints and ("google", "translate") in endpoints
    assert seen["vision"]["requests"][0]["imageContext"]["languageHints"][0] == "kn"


def test_default_local_ocr_over_http_never_calls_google(monkeypatch):
    seen: dict = {}
    t = _both(seen)
    with _client(monkeypatch, GoogleCloud(KEY, transport=t, async_transport=t)) as c:
        r = c.post("/extract", files={"file": ("kn.png", _png(), "image/png")}, data={"kind": "image", "filename": "kn.png", "translateMode": "off"})
    assert r.status_code == 200, r.text
    assert "vision" not in seen and "translate" not in seen
    assert r.json()["artifact"]["ocrProvider"] != "google_vision"
