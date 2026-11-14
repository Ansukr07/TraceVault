"""LLM client (spec §5.12): Groq (OpenAI-compatible, default qwen/qwen3.8-27b) in `cloud` / `cloud_redacted`,
Ollama in `local`.

Returns None when no provider is usable so callers fall back to deterministic output.
Prompts and responses are never persisted; callers record only model + prompt version.
"""
from __future__ import annotations

import json
import os
import re

import httpx

DEFAULT_MODEL = "qwen/qwen3.8-27b"


def _api_key() -> str | None:
    return os.environ.get("LLM_API_KEY") or os.environ.get("GROQ_API_KEY") or None


def provider_for(mode: str) -> str | None:
    if mode in ("cloud", "cloud_redacted") and _api_key():
        return "groq"
    if mode == "local" and os.environ.get("OLLAMA_BASE_URL"):
        return "ollama"
    return None


async def complete_json(system: str, user: str, *, mode: str, purpose: str = "summary", max_tokens: int = 4000) -> tuple[dict | None, dict]:
    """Returns (parsed JSON or None, meta{provider, model})."""
    prov = provider_for(mode)
    if prov == "groq":
        model = os.environ.get("LLM_SUMMARY_MODEL" if purpose == "summary" else "LLM_EXTRACT_MODEL") or os.environ.get("LLM_MODEL", DEFAULT_MODEL)
        base = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
        body = {"model": model, "max_tokens": max_tokens, "temperature": 0, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        try:
            async with httpx.AsyncClient(timeout=float(os.environ.get("LLM_TIMEOUT_SECONDS", "60"))) as c:
                r = await c.post(f"{base}/chat/completions", json=body, headers={"Authorization": f"Bearer {_api_key()}"})
                r.raise_for_status()
            return _parse(r.json()["choices"][0]["message"]["content"]), {"provider": "groq", "model": model}
        except Exception as e:  # noqa: BLE001
            return None, {"provider": "groq", "model": model, "error": type(e).__name__}
    if prov == "ollama":
        model = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")
        try:
            async with httpx.AsyncClient(timeout=180) as c:
                r = await c.post(f"{os.environ['OLLAMA_BASE_URL'].rstrip('/')}/api/chat", json={
                    "model": model, "stream": False, "format": "json",
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
                r.raise_for_status()
                return _parse(r.json()["message"]["content"]), {"provider": "ollama", "model": model}
        except Exception as e:  # noqa: BLE001
            return None, {"provider": "ollama", "model": model, "error": type(e).__name__}
    return None, {"provider": None, "model": None}


def _parse(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def openai_compatible_configured() -> bool:
    return bool(os.environ.get("LLM_API_KEY") or os.environ.get("GROQ_API_KEY"))


def chat_json(system: str, user: dict | str, *, temperature: float = 0) -> dict | None:
    """Synchronous JSON chat over an OpenAI-compatible endpoint (default Groq: LLM_BASE_URL / LLM_MODEL / LLM_API_KEY).

    Used by ingestion helpers that run in worker threads. Returns None when unconfigured or on failure.
    """
    key = _api_key()
    if not key:
        return None
    base = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
    body = {
        "model": os.environ.get("LLM_MODEL", DEFAULT_MODEL),
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user if isinstance(user, str) else json.dumps(user, ensure_ascii=False)}],
    }
    try:
        r = httpx.post(f"{base}/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"},
                       timeout=float(os.environ.get("LLM_TIMEOUT_SECONDS", "60")))
        r.raise_for_status()
        return _parse(r.json()["choices"][0]["message"]["content"])
    except Exception:  # noqa: BLE001
        return None
