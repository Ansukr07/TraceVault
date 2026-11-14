"""Single entry point for every Sarvam AI call (spec §6, §6.8).

Model names, retries, rate limiting and usage metering live here. The ML service has
no DB access, so usage records are collected per request and returned to the caller
(Node persists them in `providerUsage`). No content is ever put in a usage record.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx


class SarvamError(Exception):
    """Raised after retries are exhausted or on a non-retryable error."""

    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class SarvamUnavailable(SarvamError):
    """No API key / mock disabled: caller should fall back to local processing."""


def _env(name: str, default: str) -> str:
    return os.environ.get(name) or default


@dataclass
class SarvamConfig:
    api_key: str = ""
    base_url: str = "https://api.sarvam.ai"
    stt_model: str = "saaras:v4"
    translate_model: str = "mayura:v1"
    tts_model: str = "bulbul:v3"
    tts_speaker: str = "shubh"
    max_rps: float = 5.0
    timeout_s: float = 30.0
    max_attempts: int = 3
    mock: bool = False
    batch_poll_s: float = 5.0
    batch_timeout_s: float = 900.0

    @classmethod
    def from_env(cls) -> "SarvamConfig":
        return cls(
            api_key=os.environ.get("SARVAM_API_KEY", ""),
            base_url=_env("SARVAM_BASE_URL", "https://api.sarvam.ai").rstrip("/"),
            stt_model=_env("SARVAM_STT_MODEL", "saaras:v4"),
            translate_model=_env("SARVAM_TRANSLATE_MODEL", "mayura:v1"),
            tts_model=_env("SARVAM_TTS_MODEL", "bulbul:v3"),
            tts_speaker=_env("SARVAM_TTS_DEFAULT_SPEAKER", "shubh"),
            max_rps=float(_env("SARVAM_MAX_RPS", "5")),
            mock=os.environ.get("SARVAM_MOCK", "").lower() == "true",
            batch_poll_s=float(_env("SARVAM_BATCH_POLL_SEC", "5")),
        )


class TokenBucket:
    """Async token bucket shared by every call made through one client instance."""

    def __init__(self, rate: float, capacity: float | None = None):
        self.rate = max(rate, 0.1)
        self.capacity = capacity or max(1.0, rate)
        self.tokens = self.capacity
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def take(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)


@dataclass
class UsageLog:
    records: list[dict[str, Any]] = field(default_factory=list)

    def add(self, **rec: Any) -> None:
        self.records.append({"provider": "sarvam", **rec})


@dataclass
class SttResult:
    text: str
    lang: str | None
    lang_confidence: float | None
    model: str


class SarvamClient:
    def __init__(self, config: SarvamConfig | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.cfg = config or SarvamConfig.from_env()
        self.bucket = TokenBucket(self.cfg.max_rps)
        self._transport = transport
        self._http: httpx.AsyncClient | None = None

    # ------------------------------------------------------------------ plumbing
    @property
    def available(self) -> bool:
        return self.cfg.mock or bool(self.cfg.api_key)

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                base_url=self.cfg.base_url,
                timeout=self.cfg.timeout_s,
                headers={"api-subscription-key": self.cfg.api_key},
                transport=self._transport,
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def _post(self, endpoint: str, usage: UsageLog | None, meter: dict[str, Any], **kwargs: Any) -> dict:
        if not self.cfg.api_key:
            raise SarvamUnavailable("SARVAM_API_KEY is not set")
        last: SarvamError | None = None
        for attempt in range(self.cfg.max_attempts):
            await self.bucket.take()
            t0 = time.monotonic()
            status: int | str
            try:
                r = await self._client().post(endpoint, **kwargs)
                status = r.status_code
            except (httpx.TimeoutException, httpx.TransportError) as e:
                status = "timeout" if isinstance(e, httpx.TimeoutException) else "network_error"
                last = SarvamError(f"{endpoint}: {status}", retryable=True)
            else:
                if r.status_code < 400:
                    if usage:
                        usage.add(endpoint=endpoint, status=status, latencyMs=int((time.monotonic() - t0) * 1000), **meter)
                    return r.json()
                retryable = r.status_code == 429 or r.status_code >= 500
                last = SarvamError(f"{endpoint}: HTTP {r.status_code}", status=r.status_code, retryable=retryable)
            if usage:
                usage.add(endpoint=endpoint, status=status, latencyMs=int((time.monotonic() - t0) * 1000), **meter)
            if not last.retryable or attempt == self.cfg.max_attempts - 1:
                break
            await asyncio.sleep(0.5 * 2**attempt)
        assert last is not None
        raise last

    # ------------------------------------------------------------------ API
    async def stt(self, wav: bytes, *, mode: str = "transcribe", language_code: str = "unknown",
                  audio_seconds: float = 0.0, usage: UsageLog | None = None) -> SttResult:
        """Speech-to-text. `mode='transcribe'` → spoken language; `mode='translate'` → English."""
        if self.cfg.mock:
            return _mock_stt(wav, mode, self.cfg.stt_model, usage, audio_seconds)
        data = {"model": self.cfg.stt_model, "mode": mode}
        if mode != "translate":
            data["language_code"] = language_code
        body = await self._post(
            "/speech-to-text", usage, {"model": self.cfg.stt_model, "audioSeconds": round(audio_seconds, 2)},
            data=data, files={"file": ("segment.wav", wav, "audio/wav")},
        )
        return SttResult(
            text=(body.get("transcript") or "").strip(),
            lang=body.get("language_code"),
            lang_confidence=body.get("language_probability"),
            model=self.cfg.stt_model,
        )

    async def translate(self, text: str, *, source: str = "auto", target: str = "en-IN",
                        usage: UsageLog | None = None) -> tuple[str, str | None]:
        if self.cfg.mock:
            if usage:
                usage.add(endpoint="/translate", model=self.cfg.translate_model, chars=len(text), status="mock", latencyMs=0)
            return (text if target.startswith("en") and source.startswith("en") else f"[en] {text}"), source
        body = await self._post(
            "/translate", usage, {"model": self.cfg.translate_model, "chars": len(text)},
            json={"input": text, "source_language_code": source, "target_language_code": target,
                  "model": self.cfg.translate_model},
        )
        return body.get("translated_text", ""), body.get("source_language_code")

    async def text_lid(self, text: str, usage: UsageLog | None = None) -> tuple[str | None, str | None]:
        if self.cfg.mock:
            return None, None
        body = await self._post("/text-lid", usage, {"model": "text-lid", "chars": len(text)}, json={"input": text})
        return body.get("language_code"), body.get("script_code")

    async def tts(self, text: str, *, lang: str, speaker: str | None = None, usage: UsageLog | None = None) -> bytes:
        """Returns WAV bytes for one chunk of text (≤ 2500 chars)."""
        speaker = speaker or self.cfg.tts_speaker
        if self.cfg.mock:
            from .audio import silence_wav

            if usage:
                usage.add(endpoint="/text-to-speech", model=self.cfg.tts_model, chars=len(text), status="mock", latencyMs=0)
            return silence_wav(max(0.3, len(text) * 0.06))
        body = await self._post(
            "/text-to-speech", usage, {"model": self.cfg.tts_model, "chars": len(text)},
            json={"text": text, "language_code": lang, "model": self.cfg.tts_model, "speaker": speaker,
                  "speech_sample_rate": 16000},
        )
        audios = body.get("audios") or []
        if not audios:
            raise SarvamError("/text-to-speech: empty response")
        return base64.b64decode(audios[0])

    async def _get(self, endpoint: str, usage: UsageLog | None, meter: dict[str, Any]) -> dict:
        if not self.cfg.api_key:
            raise SarvamUnavailable("SARVAM_API_KEY is not set")
        await self.bucket.take()
        t0 = time.monotonic()
        r = await self._client().get(endpoint)
        if usage:
            usage.add(endpoint=endpoint, status=r.status_code, latencyMs=int((time.monotonic() - t0) * 1000), **meter)
        if r.status_code >= 400:
            raise SarvamError(f"{endpoint}: HTTP {r.status_code}", status=r.status_code, retryable=r.status_code >= 500)
        return r.json()

    async def diarize(self, wav: bytes, *, num_speakers: int | None = None, audio_seconds: float = 0.0,
                      usage: UsageLog | None = None) -> list[dict[str, Any]]:
        """Speaker turns via Sarvam's batch STT job API (spec 6.2).

        Returns [{startMs, endMs, speaker: 'SPEAKER_1', text}]. Flow: create, upload, start, poll, download.
        Endpoint shapes follow Sarvam's batch docs but have NOT been exercised against the live service
        (no key in CI); every step is defensive and failures raise SarvamError so the caller falls back.
        """
        if self.cfg.mock:
            return _mock_diarize(wav, num_speakers, self.cfg.stt_model, usage, audio_seconds)
        meter = {"model": self.cfg.stt_model, "audioSeconds": round(audio_seconds, 2)}
        params: dict[str, Any] = {"model": self.cfg.stt_model, "mode": "transcribe", "language_code": "unknown",
                                  "with_diarization": True}
        if num_speakers:
            params["num_speakers"] = num_speakers
        job = await self._post("/speech-to-text/job/v1", usage, meter, json={"job_parameters": params})
        job_id = job.get("job_id")
        if not job_id:
            raise SarvamError("batch job creation returned no job_id")
        name = "audio.wav"
        up = await self._post("/speech-to-text/job/v1/upload-files", usage, meter, json={"job_id": job_id, "files": [name]})
        url = ((up.get("upload_urls") or {}).get(name) or {}).get("file_url")
        if not url:
            raise SarvamError("batch upload returned no url")
        async with httpx.AsyncClient(timeout=self.cfg.batch_timeout_s, transport=self._transport) as raw:
            put = await raw.put(url, content=wav, headers={"x-ms-blob-type": "BlockBlob", "Content-Type": "audio/wav"})
            if put.status_code >= 400:
                raise SarvamError(f"batch upload failed: HTTP {put.status_code}")
        await self._post(f"/speech-to-text/job/v1/{job_id}/start", usage, meter, json={})
        deadline = time.monotonic() + self.cfg.batch_timeout_s
        while True:
            st = await self._get(f"/speech-to-text/job/v1/{job_id}/status", usage, meter)
            state = str(st.get("job_state", "")).lower()
            if state in ("completed", "success", "succeeded"):
                break
            if state in ("failed", "error"):
                raise SarvamError(f"batch job failed: {st.get('error_message') or state}")
            if time.monotonic() > deadline:
                raise SarvamError("batch job timed out")
            await asyncio.sleep(self.cfg.batch_poll_s)
        dl = await self._post("/speech-to-text/job/v1/download-files", usage, meter, json={"job_id": job_id, "files": [name]})
        out_url = next(iter((dl.get("download_urls") or {}).values()), {}).get("file_url")
        if not out_url:
            raise SarvamError("batch download returned no url")
        async with httpx.AsyncClient(timeout=self.cfg.timeout_s, transport=self._transport) as raw:
            res = await raw.get(out_url)
            res.raise_for_status()
            body = res.json()
        return _parse_diarized(body)

    async def ping(self) -> dict[str, Any]:
        """Cheap reachability/key check for /health (text-lid on one word)."""
        if self.cfg.mock:
            return {"reachable": True, "keyValid": True, "mock": True}
        if not self.cfg.api_key:
            return {"reachable": None, "keyValid": False, "mock": False}
        try:
            r = await self._client().post("/text-lid", json={"input": "hello"}, timeout=5)
        except httpx.HTTPError:
            return {"reachable": False, "keyValid": None, "mock": False}
        return {"reachable": True, "keyValid": r.status_code not in (401, 403), "mock": False}


# ---------------------------------------------------------------------- mock
def _mock_stt(wav: bytes, mode: str, model: str, usage: UsageLog | None, audio_seconds: float) -> SttResult:
    """Deterministic fixture: a fixture file keyed by audio hash wins, else a placeholder."""
    import json
    from pathlib import Path

    digest = hashlib.sha256(wav).hexdigest()
    fixture = Path(__file__).parent / "mock" / f"{digest[:16]}.json"
    if usage:
        usage.add(endpoint="/speech-to-text", model=model, audioSeconds=round(audio_seconds, 2), status="mock", latencyMs=0)
    if fixture.exists():
        data = json.loads(fixture.read_text(encoding="utf-8"))
        text = data["textEn"] if mode == "translate" else data["text"]
        return SttResult(text=text, lang="en-IN" if mode == "translate" else data.get("lang"), lang_confidence=0.99, model=model)
    if mode == "translate":
        return SttResult(text=f"[mock English transcript {digest[:8]}]", lang="en-IN", lang_confidence=None, model=model)
    return SttResult(text=f"[mock transcript {digest[:8]}]", lang="hi-IN", lang_confidence=0.9, model=model)


def _parse_diarized(body: dict[str, Any]) -> list[dict[str, Any]]:
    entries = (body.get("diarized_transcript") or {}).get("entries") or []
    labels: dict[str, str] = {}
    turns = []
    for e in entries:
        raw = str(e.get("speaker_id", "0"))
        label = labels.setdefault(raw, f"SPEAKER_{len(labels) + 1}")
        turns.append({"startMs": int(float(e.get("start_time_seconds", 0)) * 1000),
                      "endMs": int(float(e.get("end_time_seconds", 0)) * 1000),
                      "speaker": label, "text": (e.get("transcript") or "").strip()})
    return [t for t in turns if t["endMs"] > t["startMs"]]


def _mock_diarize(wav: bytes, num_speakers: int | None, model: str, usage: UsageLog | None,
                  audio_seconds: float) -> list[dict[str, Any]]:
    """Deterministic fixture: a `<hash>.json` with `turns`, else VAD segments alternating between speakers."""
    import json
    from pathlib import Path

    from . import audio as _audio

    if usage:
        usage.add(endpoint="/speech-to-text/job/v1", model=model, audioSeconds=round(audio_seconds, 2), status="mock", latencyMs=0)
    fixture = Path(__file__).parent / "mock" / f"{hashlib.sha256(wav).hexdigest()[:16]}.json"
    if fixture.exists():
        turns = json.loads(fixture.read_text(encoding="utf-8")).get("turns")
        if turns:
            return turns
    n = max(2, num_speakers or 2)
    segs = _audio.segment(_audio.read_pcm(wav))
    return [{"startMs": g.start_ms, "endMs": g.end_ms, "speaker": f"SPEAKER_{i % n + 1}", "text": ""}
            for i, g in enumerate(segs)]


_client_singleton: SarvamClient | None = None


def get_client() -> SarvamClient:
    global _client_singleton
    if _client_singleton is None:
        _client_singleton = SarvamClient()
    return _client_singleton


def reset_client() -> None:
    """Testing hook: rebuild the client from the current environment."""
    global _client_singleton
    _client_singleton = None
