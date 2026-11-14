"""Batch translation of chunks to an English working copy (spec §6.3)."""
from __future__ import annotations

import asyncio

from ..voice.sarvam_client import SarvamClient, SarvamError, UsageLog
from . import detect as lid
from .redact import redact, restore


def _src(src: str | None) -> str:
    return "auto" if not src or src.endswith("-Latn") else src


async def translate_one(client: SarvamClient, text: str, src: str | None, *, redacted: bool,
                        pii: dict[str, str] | None, usage: UsageLog, target: str = "en-IN") -> dict:
    sent, mapping = redact(text, pii) if redacted else (text, {})
    for _ in range(2):
        try:
            out, detected = await client.translate(sent, source=_src(src), target=target, usage=usage)
        except SarvamError as e:
            return {"text": None, "error": str(e)}
        restored, ok = restore(out, mapping)
        if ok:
            return {"text": restored, "src": detected or src, "provider": "sarvam", "model": client.cfg.translate_model,
                    "redacted": bool(mapping)}
    return {"text": None, "error": "PLACEHOLDER_MISMATCH"}


async def annotate_chunks(chunks: list[dict], *, client: SarvamClient, mode: str, usage: UsageLog,
                          pii: dict[str, str] | None = None) -> None:
    """Sets lang/langConfidence on every chunk, and textEn/translation where translation runs.
    `mode` is the case's translateMode: 'sarvam' | 'sarvam_redacted' | 'off'."""
    todo = []
    for c in chunks:
        if c.get("lang"):  # audio segments already carry STT language + textEn
            continue
        lang, conf, _amb = lid.detect(c["text"])
        c["lang"], c["langConfidence"] = lang, conf
        if lang and lang.startswith("en"):
            c["textEn"] = c["text"]
        elif lid.needs_translation(lang, conf) and mode != "off" and client.available:
            todo.append(c)
    sem = asyncio.Semaphore(3)

    async def run(c: dict) -> None:
        async with sem:
            r = await translate_one(client, c["text"], c["lang"], redacted=mode == "sarvam_redacted", pii=pii, usage=usage)
        if r.get("text"):
            c["textEn"] = r["text"]
            c["translation"] = {"provider": r["provider"], "model": r["model"], "redacted": r["redacted"]}
        else:
            c["translationError"] = r.get("error")

    await asyncio.gather(*[run(c) for c in todo])
