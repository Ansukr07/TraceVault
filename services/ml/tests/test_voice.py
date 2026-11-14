import asyncio
import json
import math

import httpx
import pytest
from fastapi.testclient import TestClient

from app.lang.detect import detect, needs_translation
from app.lang.redact import redact, restore
from app.voice import audio
from app.voice import sarvam_client as sc
from app.voice.sarvam_client import SarvamClient, SarvamConfig
from app.voice.transcribe import UNTRANSCRIBED, transcribe

SR = audio.SAMPLE_RATE


def tone(ms: int, amp: int = 8000, hz: int = 220) -> list[int]:
    return [int(amp * math.sin(2 * math.pi * hz * i / SR)) for i in range(SR * ms // 1000)]


def quiet(ms: int) -> list[int]:
    return [0] * (SR * ms // 1000)


def make_wav(*parts: list[int]) -> bytes:
    pcm: list[int] = []
    for p in parts:
        pcm.extend(p)
    return audio.to_wav(pcm)


# ------------------------------------------------------------------ audio / VAD
def test_segments_follow_speech_and_keep_original_time_axis():
    wav = make_wav(quiet(1000), tone(3000), quiet(2000), tone(2000), quiet(500))
    segs = audio.segment(audio.read_pcm(wav))
    assert len(segs) == 2
    assert abs(segs[0].start_ms - 1000) <= 200 and abs(segs[0].end_ms - 4000) <= 200
    assert abs(segs[1].start_ms - 6000) <= 200 and abs(segs[1].end_ms - 8000) <= 200


def test_long_speech_is_split_at_or_below_25s():
    wav = make_wav(tone(30_000), quiet(5_000), tone(32_000))
    segs = audio.segment(audio.read_pcm(wav))
    assert all(s.duration_ms <= audio.MAX_SEGMENT_MS + 2 * audio.PAD_MS for s in segs)
    assert len(segs) >= 4


def test_short_blips_merge_into_neighbour():
    wav = make_wav(tone(3000), quiet(800), tone(300), quiet(2000))
    segs = audio.segment(audio.read_pcm(wav))
    assert len(segs) == 1


def test_silence_has_no_segments():
    assert audio.segment(audio.read_pcm(make_wav(quiet(3000)))) == []


def test_normalized_wav_skips_ffmpeg(monkeypatch):
    monkeypatch.setenv("FFMPEG_PATH", "definitely-not-ffmpeg")
    wav = make_wav(tone(500))
    assert audio.normalize(wav) == wav
    with pytest.raises(audio.AudioError):
        audio.normalize(b"OggS-not-a-wav")


# ------------------------------------------------------------------ language
@pytest.mark.parametrize("text,lang", [
    ("कल रात 9 बजे मिलना वरना फोटो वायरल कर दूंगा", "hi-IN"),
    ("ನಾಳೆ ಹಣ ಕಳುಹಿಸು", "kn-IN"),
    ("Please send the money by tomorrow evening otherwise I will call the police", "en-IN"),
    ("kal raat 9 baje milna warna photos viral kar dunga", "hi-Latn"),
])
def test_detect(text, lang):
    assert detect(text)[0] == lang


def test_needs_translation():
    assert needs_translation("hi-IN", 0.9)
    assert not needs_translation("en-IN", 0.9)
    assert not needs_translation("hi-Latn", 0.6)


def test_redact_roundtrip_and_tamper_detection():
    text = "Rahul K ne bola 9876543210 pe call karo, paise rahul.k@okaxis pe bhejo, mail r@x.com"
    red, m = redact(text, {"Rahul K": "PERSON"})
    for secret in ("9876543210", "rahul.k@okaxis", "r@x.com", "Rahul K"):
        assert secret not in red
    assert "⟦PHONE_1⟧" in red and "⟦UPI_1⟧" in red and "⟦EMAIL_1⟧" in red and "⟦PERSON_1⟧" in red
    back, ok = restore(red, m)
    assert ok and back == text
    _, ok = restore(red.replace("⟦PHONE_1⟧", "PHONE 1"), m)
    assert not ok


# ------------------------------------------------------------------ fake Sarvam
class FakeSarvam:
    """httpx transport that imitates Sarvam endpoints; scripted failures per endpoint."""

    def __init__(self, fail: dict[str, list[int]] | None = None):
        self.fail = {k: list(v) for k, v in (fail or {}).items()}
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = request.content
        fields = {}
        if path == "/speech-to-text":
            for mode in ("transcribe", "translate"):
                if f'name="mode"\r\n\r\n{mode}'.encode() in body:
                    fields["mode"] = mode
        self.calls.append((path, fields))
        queue = self.fail.get(f"{path}:{fields.get('mode', '')}") or self.fail.get(path)
        if queue:
            return httpx.Response(queue.pop(0))
        if path == "/speech-to-text":
            if fields.get("mode") == "translate":
                return httpx.Response(200, json={"transcript": "meet me at 9 tonight", "language_code": "en-IN"})
            return httpx.Response(200, json={"transcript": "आज रात 9 बजे मिलो", "language_code": "hi-IN",
                                             "language_probability": 0.97})
        if path == "/translate":
            payload = json.loads(body)
            return httpx.Response(200, json={"translated_text": "EN:" + payload["input"], "source_language_code": "hi-IN"})
        if path == "/text-to-speech":
            import base64
            return httpx.Response(200, json={"audios": [base64.b64encode(audio.silence_wav(0.5)).decode()]})
        return httpx.Response(404)


def client_with(fake: FakeSarvam, **cfg) -> SarvamClient:
    return SarvamClient(SarvamConfig(api_key="test", max_rps=1000, **cfg), transport=httpx.MockTransport(fake))


def run(coro):
    return asyncio.run(coro)


def test_transcribe_bilingual_segments_and_usage():
    fake = FakeSarvam()
    wav = make_wav(quiet(500), tone(2000), quiet(1500), tone(2000))
    res = run(transcribe(wav, client=client_with(fake)))
    assert res["provider"] == "sarvam" and res["lang"] == "hi-IN" and res["fallback"] is None
    assert len(res["segments"]) == 2
    seg = res["segments"][0]
    assert seg["text"] == "आज रात 9 बजे मिलो" and seg["textEn"] == "meet me at 9 tonight"
    assert res["segments"][1]["startMs"] > seg["endMs"] - 1
    assert len(res["usage"]) == 4 and all("audioSeconds" in u for u in res["usage"])
    assert not any("transcript" in json.dumps(u) for u in res["usage"])


def test_retry_on_429_then_success():
    fake = FakeSarvam(fail={"/speech-to-text:transcribe": [429, 503]})
    res = run(transcribe(make_wav(tone(2000)), client=client_with(fake)))
    assert res["segments"][0]["text"] == "आज रात 9 बजे मिलो"
    assert [u["status"] for u in res["usage"]].count(429) == 1


def test_no_retry_on_4xx_and_segment_marked_untranscribed():
    fake = FakeSarvam(fail={"/speech-to-text:transcribe": [400]})
    wav = make_wav(tone(2000), quiet(1500), tone(2000))
    res = run(transcribe(wav, client=client_with(fake)))
    texts = [s["text"] for s in res["segments"]]
    assert texts.count(UNTRANSCRIBED) == 1 and res["provider"] == "sarvam"
    assert sum(1 for p, f in fake.calls if f.get("mode") == "transcribe") == 2


def test_translate_fallback_when_speech_translate_fails():
    fake = FakeSarvam(fail={"/speech-to-text:translate": [400]})
    res = run(transcribe(make_wav(tone(2000)), client=client_with(fake)))
    seg = res["segments"][0]
    assert seg["textEn"] == "EN:आज रात 9 बजे मिलो" and seg["textEnVia"] == "translate"


def test_full_outage_falls_back_and_never_crashes(monkeypatch):
    monkeypatch.setattr("app.voice.local_whisper.available", lambda: False)
    fake = FakeSarvam(fail={"/speech-to-text": [500] * 50})
    res = run(transcribe(make_wav(tone(2000)), client=client_with(fake, max_attempts=2)))
    assert res["fallback"] == "sarvam_failed" and res["provider"] == "none"
    assert res["segments"][0]["text"] == UNTRANSCRIBED


def test_missing_key_falls_back_to_local(monkeypatch):
    calls = []

    async def fake_local(wav):
        calls.append(len(wav))
        return {"lang": "en-IN", "langConfidence": 0.9,
                "segments": [{"startMs": 0, "endMs": 2000, "text": "hello", "textEn": "hello", "lang": "en-IN"}]}

    monkeypatch.setattr("app.voice.transcribe.transcribe_local", fake_local)
    res = run(transcribe(make_wav(tone(2000)), client=SarvamClient(SarvamConfig(api_key=""))))
    assert res["provider"] == "local_whisper" and res["fallback"] == "sarvam_unconfigured" and calls


def test_retranscribe_only_selected_segments():
    fake = FakeSarvam()
    wav = make_wav(tone(2000), quiet(1500), tone(2000))
    res = run(transcribe(wav, client=client_with(fake), segments=[(3500, 5500)]))
    assert [(s["startMs"], s["endMs"]) for s in res["segments"]] == [(3500, 5500)]


# ------------------------------------------------------------------ HTTP routes (mock mode)
@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("INTERNAL_SECRET", "s3cret")
    monkeypatch.setenv("SARVAM_MOCK", "true")
    monkeypatch.setenv("SARVAM_API_KEY", "")
    sc.reset_client()
    from app.main import _sarvam_health, app

    _sarvam_health["value"] = None
    with TestClient(app, headers={"x-internal-secret": "s3cret"}) as c:
        yield c
    sc.reset_client()


def test_route_requires_secret(api):
    r = TestClient(api.app).get("/health")
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"


def test_health_reports_sarvam(api):
    body = api.get("/health").json()
    assert body["providers"]["sarvam"]["mock"] is True and body["providers"]["sarvam"]["reachable"] is True


def test_transcribe_route_mock(api):
    wav = make_wav(quiet(300), tone(2000))
    r = api.post("/transcribe", files={"file": ("v.wav", wav, "audio/wav")}, data={"provider": "sarvam"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "sarvam" and body["segments"][0]["text"].startswith("[mock transcript")
    assert body["segments"][0]["textEn"].startswith("[mock English")
    assert body["diarization"]["applied"] is False


def test_transcribe_route_rejects_undecodable(api, monkeypatch):
    monkeypatch.setenv("FFMPEG_PATH", "definitely-not-ffmpeg")
    r = api.post("/transcribe", files={"file": ("v.ogg", b"OggS....", "audio/ogg")})
    assert r.status_code == 422 and r.json()["error"]["code"] == "AUDIO_DECODE_FAILED"


def test_voice_query_limit(api):
    r = api.post("/voice/transcribe-query", files={"file": ("q.wav", make_wav(quiet(31_000)), "audio/wav")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "TOO_LONG"
    r = api.post("/voice/transcribe-query", files={"file": ("q.wav", make_wav(tone(3000)), "audio/wav")})
    assert r.status_code == 200 and r.json()["text"]


def test_lang_and_translate_routes(api):
    r = api.post("/lang/detect", json={"items": [{"id": "a", "text": "कल रात मिलो"}, {"id": "b", "text": "send money now please"}]})
    langs = {i["id"]: i for i in r.json()["items"]}
    assert langs["a"]["lang"] == "hi-IN" and langs["a"]["needsTranslation"]
    r = api.post("/translate", json={"items": [{"id": "a", "text": "9876543210 pe call karo", "src": "hi-Latn"}]})
    item = r.json()["items"][0]
    assert item["text"] == "[en] 9876543210 pe call karo" and item["redacted"] is True


def test_tts_route_timings(api):
    r = api.post("/tts", json={"text": "Rahul sent threats [E1:3]. He asked for ₹5,000 [E2:1][E2:2]! Done.", "lang": "en-IN"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    timings = json.loads(r.headers["x-sentence-timings"])
    assert len(timings) == 3 and timings[1]["startMs"] == timings[0]["endMs"]
    assert audio.duration_ms(audio.read_pcm(r.content)) == timings[-1]["endMs"]
