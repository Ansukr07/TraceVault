"""WhatsApp chat export parser (Android + iOS), spec I1.

Each message is one chunk: the atomic unit of citation. Spans/line numbers point into the
original text, which is never modified.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

# Android: "12/05/24, 9:41 pm - Rahul: text"   iOS: "[12/05/2024, 9:41:23 pm] Rahul: text"
_LINE = re.compile(
    r"""^‎?\[?
        (?P<a>\d{1,2})[/.-](?P<b>\d{1,2})[/.-](?P<y>\d{2,4}),?\s+
        (?P<h>\d{1,2})[:.](?P<m>\d{2})(?:[:.](?P<s>\d{2}))?
        (?:\s?(?P<ampm>[AaPp]\.?[Mm]\.?))?
        \]?\s*(?:-\s)?
        (?P<rest>.*)$""",
    re.VERBOSE,
)
_MEDIA = re.compile(
    r"(?:<attached:\s*(?P<att>[^>]+)>|(?P<file>[\w\-. ()]+\.\w{2,5})\s*\(file attached\)|(?P<omit><Media omitted>|image omitted|audio omitted|video omitted|sticker omitted))",
    re.IGNORECASE,
)


@dataclass
class Message:
    idx: int
    line_no: int
    ts: datetime | None
    sender: str | None  # None => system message
    text: str
    media: str | None = None  # attached filename, or "omitted"
    is_system: bool = False


@dataclass
class ParsedChat:
    messages: list[Message] = field(default_factory=list)
    date_order: str = "DMY"  # or "MDY"
    participants: list[str] = field(default_factory=list)


def _detect_order(pairs: list[tuple[int, int]]) -> str:
    """DD/MM vs MM/DD: a value > 12 in a slot pins that slot as the day. Ambiguous => DD/MM (India)."""
    if any(a > 12 for a, _ in pairs):
        return "DMY"
    if any(b > 12 for _, b in pairs):
        return "MDY"
    return "DMY"


def _to_dt(m: re.Match, order: str) -> datetime | None:
    a, b, y = int(m["a"]), int(m["b"]), int(m["y"])
    day, month = (a, b) if order == "DMY" else (b, a)
    y += 2000 if y < 100 else 0
    h, mi, s = int(m["h"]), int(m["m"]), int(m["s"] or 0)
    if m["ampm"]:
        pm = m["ampm"].lower().startswith("p")
        h = h % 12 + (12 if pm else 0)
    try:
        return datetime(y, month, day, h, mi, s)
    except ValueError:
        return None


def parse_whatsapp(text: str) -> ParsedChat:
    text = text.lstrip("﻿")
    lines = text.splitlines()
    heads: list[tuple[int, re.Match]] = []
    for i, line in enumerate(lines):
        m = _LINE.match(line)
        if m:
            heads.append((i, m))
    order = _detect_order([(int(m["a"]), int(m["b"])) for _, m in heads])

    out = ParsedChat(date_order=order)
    for n, (i, m) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        rest = m["rest"]
        # "Sender: body" — sender can't contain ": ". Anything else is a system line.
        sm = re.match(r"^(?P<sender>[^:]{1,80}?):\s(?P<body>.*)$", rest)
        sender, body = (sm["sender"].strip("‪‬‎ "), sm["body"]) if sm else (None, rest)
        body = "\n".join([body, *lines[i + 1 : end]]).strip("‎").rstrip()
        media = None
        mm = _MEDIA.search(body)
        if mm:
            media = (mm["att"] or mm["file"] or "omitted").strip()
        out.messages.append(
            Message(idx=n, line_no=i + 1, ts=_to_dt(m, order), sender=sender, text=body, media=media, is_system=sender is None)
        )
    out.participants = sorted({m.sender for m in out.messages if m.sender})
    return out
