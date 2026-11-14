from __future__ import annotations

import json
import re
from typing import Any


def parse_telegram(data: dict[str, Any]) -> dict[str, Any]:
    messages = []
    for idx, item in enumerate(data.get("messages", [])):
        text = _text(item.get("text", ""))
        media = [str(item[key]) for key in ("file", "photo", "media_type") if item.get(key)]
        messages.append({"index": idx, "timestamp": item.get("date") or item.get("date_unixtime"), "sender": item.get("from") or item.get("actor"), "text": text, "media": media, "locator": {"messageIdx": idx, "messageId": item.get("id")}})
    return {"format": "telegram_json", "messages": messages, "dateOrder": None, "warnings": []}


def parse_instagram(data: dict[str, Any]) -> dict[str, Any]:
    messages = []
    records = data.get("messages", data.get("conversation", []))
    for idx, item in enumerate(records):
        sender = item.get("sender_name") or item.get("sender") or item.get("name")
        timestamp = item.get("timestamp_ms") or item.get("timestamp") or item.get("date")
        body = item.get("content") or item.get("text") or ""
        media = [str(x.get("uri") or x.get("path")) for x in item.get("photos", []) + item.get("videos", []) if isinstance(x, dict)]
        messages.append({"index": idx, "timestamp": timestamp, "sender": sender, "text": _text(body), "media": media, "locator": {"messageIdx": idx, "messageId": item.get("id")}})
    return {"format": "instagram_or_takeout_json", "messages": messages, "dateOrder": None, "warnings": []}


def parse_json_text(text: str, source: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON export: {exc}") from exc
    if source == "telegram":
        return parse_telegram(data)
    if source in {"instagram", "takeout"}:
        return parse_instagram(data)
    raise ValueError("source must be telegram, instagram, or takeout")


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in value)
    return str(value or "")
