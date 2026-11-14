from __future__ import annotations

import re
from datetime import datetime
from typing import Any

ANDROID = re.compile(r"^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s?[APap][Mm])?)\s+-\s+(.*)$")
IOS = re.compile(r"^\[(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]\s+(.*)$")
MEDIA = re.compile(r"<(?:attached: )?([^>]+)>|\b(image omitted|video omitted|audio omitted|sticker omitted|GIF omitted|document omitted)\b", re.I)


def parse(text: str, date_order: str = "auto") -> dict[str, Any]:
    lines = text.replace("\ufeff", "").splitlines()
    parsed: list[dict[str, Any]] = []
    warnings: list[str] = []
    active: dict[str, Any] | None = None
    date_samples: list[str] = []
    for line_no, line in enumerate(lines, 1):
        match = ANDROID.match(line) or IOS.match(line)
        if not match:
            if active is not None:
                active["text"] += "\n" + line
                active["lineEnd"] = line_no
            continue
        date_text, time_text, content = match.group(1), match.group(2), match.group(3)
        date_samples.append(date_text)
        if active:
            parsed.append(active)
        sender, body = _split_sender(content)
        attachments = [m.group(1) or m.group(0) for m in MEDIA.finditer(body)]
        active = {"timestamp": f"{date_text} {time_text}", "sender": sender, "text": body, "media": attachments, "lineStart": line_no, "lineEnd": line_no}
    if active:
        parsed.append(active)
    inferred = _infer_date_order(date_samples)
    chosen = inferred if date_order == "auto" else date_order.upper()
    if chosen not in {"DMY", "MDY", "YMD"}:
        warnings.append("Could not confidently detect date order; DMY was used as the Indian-locale default.")
        chosen = "DMY"
    elif date_order == "auto" and inferred is None:
        warnings.append("Date order is ambiguous for this export; DMY default selected. Pass date_order=MDY or DMY to override.")
    for idx, message in enumerate(parsed):
        message["index"] = idx
        message["timestampIso"] = _parse_timestamp(message["timestamp"], chosen)
        message["locator"] = {"lineStart": message.pop("lineStart"), "lineEnd": message.pop("lineEnd"), "messageIdx": idx}
    return {"format": "whatsapp_export", "messages": parsed, "dateOrder": chosen, "warnings": warnings}


def _split_sender(content: str) -> tuple[str | None, str]:
    if ": " in content:
        sender, body = content.split(": ", 1)
        return sender.strip(), body
    return None, content


def _infer_date_order(dates: list[str]) -> str | None:
    for value in dates:
        parts = re.split(r"[/-]", value)
        if len(parts) < 3:
            continue
        try:
            first, second = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        if first > 12 and second <= 12:
            return "DMY"
        if second > 12 and first <= 12:
            return "MDY"
        if len(parts[0]) == 4:
            return "YMD"
    return None


def _parse_timestamp(value: str, order: str) -> str | None:
    date_fmts = ["%d/%m/%y", "%d/%m/%Y", "%d-%m-%y", "%d-%m-%Y"] if order == "DMY" else ["%m/%d/%y", "%m/%d/%Y", "%m-%d-%y", "%m-%d-%Y"] if order == "MDY" else ["%Y/%m/%d", "%Y-%m-%d"]
    normalized = value.replace(",", "").strip()
    for date_fmt in date_fmts:
        for time_fmt in ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M:%S %p"):
            try:
                return datetime.strptime(normalized, f"{date_fmt} {time_fmt}").isoformat()
            except ValueError:
                continue
    return None
