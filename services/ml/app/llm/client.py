"""LLM client (spec §5.12): Claude in `cloud` / `cloud_redacted`, Ollama in `local`.

Returns None when no provider is usable so callers fall back to deterministic output.
Prompts and responses are never persisted; callers record only model + prompt version.
"""
from __future__ import annotations

import json
import os
import re

import httpx


def provider_for(mode: str) -> str | None:
    if mode in ("cloud", "cloud_redacted") and os.environ.get("ANTHROPIC_API_KEY"):
        return "claude"
    if mode == "local" and os.environ.get("OLLAMA_BASE_URL"):
        return "ollama"
    return None


async def complete_json(system: str, user: str, *, mode: str, purpose: str = "summary", max_tokens: int = 4000) -> tuple[dict | None, dict]:
    """Returns (parsed JSON or None, meta{provider, model})."""
    prov = provider_for(mode)
    if prov == "claude":
        model = os.environ.get("LLM_SUMMARY_MODEL" if purpose == "summary" else "LLM_EXTRACT_MODEL",
                               "claude-sonnet-5-5" if purpose == "summary" else "claude-haiku-5-5")
        try:
            from anthropic import AsyncAnthropic

            client = AsyncAnthropic()
            msg = await client.messages.create(model=model, max_tokens=max_tokens, system=system,
                                               messages=[{"role": "user", "content": user}])
            text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
            return _parse(text), {"provider": "claude", "model": model}
        except Exception as e:  # noqa: BLE001
            return None, {"provider": "claude", "model": model, "error": type(e).__name__}
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
