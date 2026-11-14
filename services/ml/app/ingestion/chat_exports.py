"""Telegram Desktop and Instagram / Google-Takeout-style JSON chat exports (spec I9, I10).

Both are normalised into the same `ParsedChat` the WhatsApp parser produces, so everything downstream
(chunking, NER, timeline, graph) is unchanged. Returns None when the JSON isn't a recognised chat.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from .whatsapp import Message, ParsedChat


def _fix_mojibake(s: str) -> str:
    """Instagram exports UTF-8 bytes as latin-1 escapes ("à¤\x95" for Devanagari); undo that when it round-trips."""
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def _telegram_text(t: Any) -> str:
    if isinstance(t, str):
        return t
    if isinstance(t, list):  # mixed entities: ["plain", {"type": "link", "text": "..."}]
        return "".join(p if isinstance(p, str) else str(p.get("text", "")) for p in t)
    return ""


def _parse_dt(v: str) -> datetime | None:
    try:
        return datetime.fromisoformat(v)
    except (TypeError, ValueError):
        return None


def parse_json_chat(data: bytes) -> ParsedChat | None:
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        return None
    msgs_raw = doc.get("messages") if isinstance(doc, dict) else None
    if not isinstance(msgs_raw, list):
        return None
    chat = ParsedChat(date_order="ISO")
    people: list[str] = []
    seen = set()

    def add(sender: str | None, ts: datetime | None, text: str, media: str | None, system: bool, no: int) -> None:
        chat.messages.append(Message(idx=len(chat.messages), line_no=no, ts=ts, sender=None if system else sender,
                                     text=text, media=media, is_system=system))
        if sender and not system and sender not in seen:
            seen.add(sender)
            people.append(sender)

    if msgs_raw and isinstance(msgs_raw[0], dict) and "sender_name" in msgs_raw[0]:  # Instagram / Facebook
        for i, m in enumerate(reversed(msgs_raw)):  # these exports are newest-first
            ts = datetime.fromtimestamp(m["timestamp_ms"] / 1000, tz=timezone.utc).replace(tzinfo=None) if m.get("timestamp_ms") else None
            text = _fix_mojibake(m.get("content") or "")
            media = next((a.get("uri") for k in ("photos", "videos", "audio_files", "files") for a in m.get(k, []) if isinstance(a, dict)), None)
            if not text and media:
                text = "<attached: " + media.rsplit("/", 1)[-1] + ">"
            if not text:
                continue
            add(_fix_mojibake(m["sender_name"]), ts, text, media.rsplit("/", 1)[-1] if media else None, False, i + 1)
    elif msgs_raw and isinstance(msgs_raw[0], dict) and ("from" in msgs_raw[0] or msgs_raw[0].get("type") == "service"):  # Telegram
        for i, m in enumerate(msgs_raw):
            text = _telegram_text(m.get("text")).strip()
            media = m.get("file_name") or m.get("photo") or None
            if m.get("type") == "service":
                add(None, _parse_dt(m.get("date")), m.get("action", "service message"), None, True, i + 1)
                continue
            if not text and media:
                text = "<attached: " + str(media).rsplit("/", 1)[-1] + ">"
            if not text:
                continue
            add(m.get("from") or m.get("from_id"), _parse_dt(m.get("date")), text, str(media).rsplit("/", 1)[-1] if media else None, False, i + 1)
    else:
        return None
    if not chat.messages:
        return None
    chat.participants = people
    return chat


def parse_json_text(text: str, source: str) -> dict[str, Any]:
    """Message-list view used by /parse/telegram|instagram|takeout: {format, messages[], dateOrder, warnings}."""
    if source not in {"telegram", "instagram", "takeout"}:
        raise ValueError("source must be telegram, instagram, or takeout")
    try:
        json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON export: {exc}") from exc
    chat = parse_json_chat(text.encode("utf-8"))
    if chat is None:
        raise ValueError(f"Not a recognised {source} chat export")
    messages = [{"index": m.idx, "timestamp": m.ts.isoformat() if m.ts else None, "sender": m.sender, "text": m.text,
                 "media": [m.media] if m.media else [], "locator": {"messageIdx": m.idx, "lineNo": m.line_no}}
                for m in chat.messages if not m.is_system]
    fmt = "telegram_json" if source == "telegram" else "instagram_or_takeout_json"
    return {"format": fmt, "messages": messages, "dateOrder": None, "warnings": []}
