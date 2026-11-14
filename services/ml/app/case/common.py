"""Shared helpers for case-level processing."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime

IDENTIFIER_TYPES = ("PHONE", "EMAIL", "UPI_ID", "HANDLE", "BANK_ACCT", "VEHICLE_NO")
PLACE_TYPES = ("LOCATION", "ORG")
_HONORIFIC = re.compile(r"\b(mr|mrs|ms|miss|dr|sir|madam|bhai|bhaiya|ji|sahab|didi|bro)\b\.?", re.IGNORECASE)


def norm_name(s: str | None) -> str:
    s = _HONORIFIC.sub(" ", s or "")
    s = re.sub(r"[^\w\sऀ-෿]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def stable_key(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def chunk_text_en(c: dict) -> str:
    return c.get("textEn") or c.get("text") or ""


def quote(text: str, n: int = 140) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def fmt_money(v: int | float | None) -> str:
    if v is None:
        return "an unknown amount"
    s = f"{int(v):,}"
    # Indian grouping: 1,00,000
    if v >= 100000:
        head, tail = str(int(v))[:-3], str(int(v))[-3:]
        head = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", head)
        s = f"{head},{tail}"
    return f"₹{s}"


def fmt_date(ts: str | None, precision: str = "exact") -> str:
    d = parse_ts(ts)
    if not d:
        return "an unknown date"
    if precision in ("day", "approx") or (d.hour == 0 and d.minute == 0):
        return d.strftime("%d %b %Y").lstrip("0")
    return d.strftime("%d %b %Y, %I:%M %p").lstrip("0").replace(" 0", " ")
