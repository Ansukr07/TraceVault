"""Temporal normalization (spec N2): English, Hindi (Devanagari) and Hinglish expressions
resolved against the chunk's reference time.

Precision: 'exact' (date + clock time), 'day' (date only), 'approx' (vague, e.g. "raat",
"last week") — approx renders as a range bar on the timeline.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

import dateparser

_EXPLICIT_DATE = re.compile(
    r"\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+\d{4})?"
    r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b",
    re.IGNORECASE,
)
_CLOCK = re.compile(r"\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje|बजे)(?![\w\u0900-\u097F])|\b(\d{1,2})[:.](\d{2})\b", re.IGNORECASE)
_DAYPART = {
    "subah": 9, "morning": 9, "सुबह": 9, "dopahar": 14, "afternoon": 14, "दोपहर": 14,
    "shaam": 18, "sham": 18, "evening": 18, "शाम": 18, "raat": 21, "night": 21, "tonight": 21, "रात": 21,
}
_REL_DAY = {
    "today": 0, "aaj": 0, "आज": 0, "tonight": 0,
    "tomorrow": 1, "parso": 2, "परसों": 2, "yesterday": -1,
    "kal": None, "कल": None,  # ambiguous: resolved by tense
}
_REL_RANGE = {
    "next week": 7, "agle hafte": 7, "अगले हफ्ते": 7, "last week": -7, "pichle hafte": -7, "पिछले हफ्ते": -7,
    "next month": 30, "agle mahine": 30, "last month": -30, "pichle mahine": -30,
}
_WEEKDAYS = {
    "monday": 0, "somvar": 0, "tuesday": 1, "mangalvar": 1, "wednesday": 2, "budhvar": 2, "thursday": 3, "guruvar": 3,
    "friday": 4, "shukravar": 4, "saturday": 5, "shanivar": 5, "sunday": 6, "ravivar": 6, "itvaar": 6,
}
_PAST = re.compile(r"\b(tha|thi|the|kiya|kia|gaya|gayi|liya|diya|mila|aaya|aayi|did|was|were|had|sent|paid|met|called)\b|था|थी|किया|गया|दिया", re.IGNORECASE)

_WORDS = sorted({*_REL_DAY, *_DAYPART, *_WEEKDAYS}, key=len, reverse=True)
_REL_RE = re.compile(r"(?<![\w])(" + "|".join(re.escape(w) for w in _WORDS) + r")(?![\w])", re.IGNORECASE)
_RANGE_RE = re.compile("|".join(re.escape(w) for w in _REL_RANGE), re.IGNORECASE)


class _Span:
    """Minimal stand-in for re.Match covering a merged range."""

    def __init__(self, start: int, end: int, text: str):
        self._s, self._e, self._t = start, end, text

    def start(self) -> int:
        return self._s

    def end(self) -> int:
        return self._e

    def __getitem__(self, i: int) -> str:
        return self._t[self._s:self._e]


def _parse_ref(ref: str | None) -> datetime | None:
    if not ref:
        return None
    try:
        return datetime.fromisoformat(ref.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _clock(m: re.Match) -> tuple[int, int] | None:
    if m[4] is not None:
        h, mi, suffix = int(m[4]), int(m[5]), None
    else:
        h, mi, suffix = int(m[1]), int(m[2] or 0), (m[3] or "").lower()
    if suffix and suffix.startswith("p") and h < 12:
        h += 12
    if suffix and suffix.startswith("a") and h == 12:
        h = 0
    return (h, mi) if h < 24 and mi < 60 else None


def normalize(text: str, ref: str | None) -> list[dict]:
    """Return [{text, start, end, ts, precision}] for temporal expressions in `text`."""
    ref_dt = _parse_ref(ref)
    out: list[dict] = []
    past = bool(_PAST.search(text))

    # 1) explicit calendar dates
    for m in _EXPLICIT_DATE.finditer(text):
        d = dateparser.parse(m[0], settings={"DATE_ORDER": "DMY", "PREFER_DAY_OF_MONTH": "first",
                                              **({"RELATIVE_BASE": ref_dt} if ref_dt else {})})
        if d:
            out.append({"text": m[0], "start": m.start(), "end": m.end(), "ts": d.replace(hour=0, minute=0, second=0).isoformat(),
                        "precision": "day", "_day": d.date()})

    if ref_dt is None:
        return [_clean(o) for o in out]

    # 2) relative day / weekday / daypart words
    day_hits = []
    for m in _REL_RE.finditer(text):
        w = m[1].lower()
        if w in _REL_DAY:
            off = _REL_DAY[w]
            if off is None:
                off = -1 if past else 1
            day_hits.append((m, ref_dt.date() + timedelta(days=off), _DAYPART.get(w)))
        elif w in _WEEKDAYS:
            delta = (_WEEKDAYS[w] - ref_dt.weekday()) % 7
            if past:
                delta = delta - 7 if delta else -7
            day_hits.append((m, ref_dt.date() + timedelta(days=delta), None))
        elif w in _DAYPART:
            day_hits.append((m, None, _DAYPART[w]))

    # Merge "kal" + "raat" (day word directly followed/preceded by a daypart) into one hit.
    merged: list[tuple] = []
    for hit in day_hits:
        if merged:
            pm, pday, ppart = merged[-1]
            m, day, part = hit
            if hit[0].start() - pm.end() <= 3 and ((pday and not ppart and day is None and part) or (pday is None and ppart and day and not part)):
                span = _Span(pm.start(), m.end(), text)
                merged[-1] = (span, pday or day, ppart or part)
                continue
        merged.append(hit)
    day_hits = merged

    clocks = [(m, _clock(m)) for m in _CLOCK.finditer(text)]
    clocks = [(m, c) for m, c in clocks if c]
    used_clock = set()

    for m, day, part_hour in day_hits:
        # Attach the nearest clock time within 25 chars.
        near = [(abs(cm.start() - m.end()), i) for i, (cm, _) in enumerate(clocks) if abs(cm.start() - m.end()) <= 25 or abs(m.start() - cm.end()) <= 25]
        day = day or (out[-1]["_day"] if out and "_day" in out[-1] else ref_dt.date())
        if near:
            i = min(near)[1]
            used_clock.add(i)
            cm, (h, mi) = clocks[i]
            if part_hour and part_hour >= 18 and h < 12:
                h += 12  # "raat 9 baje" → 21:00
            start, end = min(m.start(), cm.start()), max(m.end(), cm.end())
            out.append({"text": text[start:end], "start": start, "end": end,
                        "ts": datetime(day.year, day.month, day.day, h, mi).isoformat(), "precision": "exact", "_day": day})
        else:
            h = part_hour if part_hour is not None else 0
            prec = "approx" if part_hour is not None else "day"
            out.append({"text": m[0], "start": m.start(), "end": m.end(),
                        "ts": datetime(day.year, day.month, day.day, h, 0).isoformat(), "precision": prec, "_day": day})

    # 3) bare clock times → same day as the reference (only with an explicit am/pm/baje suffix)
    for i, (cm, (h, mi)) in enumerate(clocks):
        if i in used_clock or cm[4] is not None:
            continue
        base = next((o["_day"] for o in out if "_day" in o and abs(o["start"] - cm.start()) < 40), ref_dt.date())
        out.append({"text": cm[0], "start": cm.start(), "end": cm.end(),
                    "ts": datetime(base.year, base.month, base.day, h, mi).isoformat(), "precision": "exact", "_day": base})

    # 4) vague ranges
    for m in _RANGE_RE.finditer(text):
        d = ref_dt + timedelta(days=_REL_RANGE[m[0].lower()])
        out.append({"text": m[0], "start": m.start(), "end": m.end(), "ts": d.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),
                    "precision": "approx"})

    # Drop expressions contained in a longer one.
    out.sort(key=lambda o: (o["start"], -(o["end"] - o["start"])))
    kept: list[dict] = []
    for o in out:
        if kept and o["start"] < kept[-1]["end"]:
            continue
        kept.append(o)
    return [_clean(o) for o in kept]


def _clean(o: dict) -> dict:
    return {k: v for k, v in o.items() if not k.startswith("_")}
