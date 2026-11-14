from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import dateparser
from dateparser.search import search_dates

from app.schemas import NormalizedTime

APPROX_MARKERS = ("last week", "this week", "next week", "few days ago", "recently", "pichhle hafte", "agle hafte")


def extract_times(chunk_id: str, text: str, ref_time: str | None, locale: str | None, timezone: str) -> list[NormalizedTime]:
    try:
        zone = ZoneInfo(timezone)
    except Exception:
        zone = ZoneInfo("Asia/Kolkata")
        timezone = "Asia/Kolkata"
    base = _parse_reference(ref_time, zone)
    settings = {"RELATIVE_BASE": base, "PREFER_DATES_FROM": "past", "TIMEZONE": timezone, "RETURN_AS_TIMEZONE_AWARE": True}
    if locale:
        settings["DATE_ORDER"] = "MDY" if locale.lower().startswith("en-us") else "DMY"
    results = search_dates(text, languages=_languages(locale), settings=settings) or []
    normalized: list[NormalizedTime] = []
    cursor = 0
    for expression, parsed in results:
        start = text.find(expression, cursor)
        if start < 0:
            start = text.find(expression)
        if start < 0:
            continue
        cursor = start + len(expression)
        vague = any(marker in expression.lower() for marker in APPROX_MARKERS)
        iso = parsed.astimezone(zone).isoformat()
        range_end = None
        if vague and "week" in expression.lower():
            range_end = (parsed + timedelta(days=6)).astimezone(zone).isoformat()
        normalized.append(NormalizedTime(chunkId=chunk_id, expression=expression, start=start, end=start + len(expression), iso=iso, rangeEnd=range_end, tsPrecision="approx" if vague else "exact", timezone=timezone))
    return normalized


def _parse_reference(value: str | None, zone: ZoneInfo) -> datetime:
    if value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=zone) if parsed.tzinfo is None else parsed.astimezone(zone)
        except ValueError:
            pass
    return datetime.now(zone)


def _languages(locale: str | None) -> list[str]:
    if locale and locale.lower().startswith("hi"):
        return ["hi", "en"]
    return ["en"]
