"""Named-entity extraction (spec N1).

Priority on overlapping spans: regex > gazetteer/patterns > statistical model (spaCy, when
installed). Regex runs on the ORIGINAL text, so mention spans always point into it.
Every entity: {type, text, start, end, norm}.
"""
from __future__ import annotations

import re
from typing import Iterable

import phonenumbers

from . import temporal

UPI_HANDLES = (
    "upi|ybl|ibl|axl|apl|okaxis|okhdfcbank|okicici|oksbi|paytm|ptyes|ptaxis|pthdfc|ptsbi|axisbank|hdfcbank|icici|sbi|"
    "kotak|yesbank|idfcbank|federal|indus|aubank|jupiteraxis|fbl|waaxis|wahdfcbank|freecharge|airtel|jio|postbank|barodampay|unionbank|cnrb|"
    "pnb|boi|cbin|ikwik|timecosmos|abfspay|naviaxis|superyes|yapl|rapl|tapicici|pingpay|slc|mbk|dbs"
)
_P = [
    ("EMAIL", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("UPI_ID", re.compile(rf"\b[\w.-]{{2,64}}@(?:{UPI_HANDLES})\b", re.IGNORECASE)),
    ("URL", re.compile(r"\bhttps?://[^\s<>\"]+|\bwww\.[^\s<>\"]+|\b(?:instagram|facebook|fb|t|wa|x|twitter)\.(?:com|me)/[\w./?=-]+", re.IGNORECASE)),
    ("HANDLE", re.compile(r"(?<![\w.@])@[A-Za-z0-9_.]{3,30}(?![\w@])")),
    ("PHONE", re.compile(r"(?<![\w@])(?:\+?91[\s-]?|0)?(?:[6-9]\d{4}[\s-]?\d{5}|[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4})(?!\d)")),
    ("BANK_ACCT", re.compile(r"(?:\ba/?c\b|\bacct\b|\baccount\b)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([xX*]{2,}\d{3,6}|\d{9,18})", re.IGNORECASE)),
    ("VEHICLE_NO", re.compile(r"\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b")),
    ("MONEY", re.compile(r"(?:\bdebit|\bcredit|\bamount|\bamt|\bwithdrawal|\bdeposit|\bdr\b|\bcr\b)\.?\s*[:\-]?\s*(\d[\d,]*\.\d{2})\b", re.IGNORECASE)),
    # Bare amount directly before a payee: "send 15000 to name@bank" (no currency marker).
    ("MONEY", re.compile(r"\b\d[\d,]{2,}(?=\s+(?:to|on|pe|par)\s+[\w.\-]+@[a-z]\w*)", re.IGNORECASE)),
    ("MONEY", re.compile(
        r"(?:₹|\brs\.?|\binr\b|\brupees?\b)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|lakh|lakhs|lac|thousand|hazaar|hazar|cr|crore)\b)?"
        r"|\b\d[\d,]*(?:\.\d+)?\s?(?:k\b|lakh\b|lakhs\b|lac\b|thousand\b|hazaar\b|hazar\b|crore\b)?\s?(?:rs\b|rupees?\b|rupaye\b|rupay\b|₹|/-)",
        re.IGNORECASE)),
]

ORGS = ["SBI", "HDFC", "ICICI", "Axis Bank", "Kotak", "Paytm", "PhonePe", "Google Pay", "GPay", "BHIM", "Instagram", "WhatsApp",
        "Facebook", "Telegram", "Snapchat", "Cyber Cell", "Police", "Amazon", "Flipkart"]
LOCATIONS = ["Bengaluru", "Bangalore", "Mumbai", "Delhi", "New Delhi", "Chennai", "Hyderabad", "Kolkata", "Pune", "Mysuru", "Mysore",
             "Jaipur", "Lucknow", "Noida", "Gurgaon", "Gurugram", "Ahmedabad", "Koramangala", "Indiranagar", "MG Road", "Whitefield",
             "Jayanagar", "HSR Layout", "BTM Layout", "Electronic City", "Marathahalli", "Basavanagudi", "Malleshwaram", "Hebbal",
             "Majestic", "Yelahanka", "Banashankari", "Rajajinagar", "Bandra", "Andheri", "Connaught Place", "Cubbon Park",
             "Lalbagh", "Forum Mall", "Orion Mall", "Phoenix Mall", "BMSCE", "metro station", "bus stop", "college gate"]
_LOC_PATTERN = re.compile(
    r"\b(?:at|near|outside|opposite|behind|in front of)\s+((?:the\s+)?[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,3})"
    r"|\b([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})\s+(?:ke\s+paas|ke\s+bahar|pe\s+milo|par\s+milo)\b"
)
_SELF_ID = re.compile(
    r"(?i:\bmain\s|\bmai\s|\bi\s+am\s|\bi'm\s|\bthis\s+is\s|\bmy\s+name\s+is\s|\bmera\s+naam\s|मैं\s)"
    r"([A-Za-z][a-z]{2,}(?:\s[A-Z][a-z]*\.?)?|[\u0900-\u097F]+)"
    r"(?=\s*(?i:bol\b|hoon\b|hu\b|here\b|speaking\b|,|\.|$|बोल))",
)


_spacy = None


def _spacy_nlp():
    global _spacy
    if _spacy is None:
        try:
            import spacy

            _spacy = spacy.load("en_core_web_trf")
        except Exception:  # noqa: BLE001  (not installed / model missing)
            try:
                import spacy

                _spacy = spacy.load("en_core_web_sm")
            except Exception:  # noqa: BLE001
                _spacy = False
    return _spacy or None


def spacy_available() -> bool:
    return _spacy_nlp() is not None


def money_value(s: str) -> int | None:
    t = s.lower().replace(",", "")
    m = re.search(r"\d+(?:\.\d+)?", t)
    if not m:
        return None
    v = float(m[0])
    if re.search(r"\b(?:k|thousand|hazaar|hazar)\b", t):
        v *= 1_000
    elif re.search(r"\b(?:lakh|lakhs|lac)\b", t):
        v *= 100_000
    elif re.search(r"\b(?:cr|crore)\b", t):
        v *= 10_000_000
    return int(round(v))


def _norm_phone(s: str) -> str | None:
    try:
        n = phonenumbers.parse(s, "IN")
    except phonenumbers.NumberParseException:
        return None
    return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164) if phonenumbers.is_valid_number(n) else None


def _overlaps(a: dict, spans: Iterable[dict]) -> bool:
    return any(a["start"] < b["end"] and b["start"] < a["end"] for b in spans)


def extract(text: str, *, known_names: Iterable[str] = (), ref_ts: str | None = None, text_en: str | None = None) -> list[dict]:
    ents: list[dict] = []

    def add(t: str, start: int, end: int, norm, **extra) -> None:
        e = {"type": t, "text": text[start:end], "start": start, "end": end, "norm": norm, **extra}
        if not _overlaps(e, ents):
            ents.append(e)

    # 1) regex (highest priority)
    for t, pat in _P:
        for m in pat.finditer(text):
            s, e = (m.start(1), m.end(1)) if (t == "BANK_ACCT" or (t == "MONEY" and m.re.groups)) else (m.start(), m.end())
            if t == "HANDLE":
                while e > s and text[e - 1] == ".":
                    e -= 1
            raw = text[s:e]
            if t == "PHONE":
                norm = _norm_phone(raw)
                if not norm:
                    continue
            elif t == "MONEY":
                norm = money_value(raw)
                if not norm:
                    continue
                if m.re.groups:
                    head = m.group(0)[:12].lower()
                    add(t, s, e, norm, direction="credit" if ("credit" in head or head.startswith("cr") or "deposit" in head) else "debit")
                    continue
            elif t in ("EMAIL", "UPI_ID", "HANDLE"):
                norm = raw.lower().lstrip("@") if t == "HANDLE" else raw.lower()
            elif t == "VEHICLE_NO":
                norm = re.sub(r"[\s-]", "", raw).upper()
            elif t == "BANK_ACCT":
                norm = raw.upper()
            else:
                norm = raw
            add(t, s, e, norm)

    # 2) temporal
    for tm in temporal.normalize(text, ref_ts):
        add("DATE" if tm["precision"] == "day" else "TIME", tm["start"], tm["end"], tm["ts"], precision=tm["precision"])

    # 3) known people (chat participants, email display names, speaker names) + self-identification
    for name in sorted({n for n in known_names if n and len(n) >= 2 and n.lower() not in ("me", "you")}, key=len, reverse=True):
        for part in {name, name.split()[0]} if len(name.split()[0]) >= 3 else {name}:
            for m in re.finditer(rf"(?<![\w]){re.escape(part)}(?![\w])", text, re.IGNORECASE):
                add("PERSON", m.start(), m.end(), name)
    for m in _SELF_ID.finditer(text):
        nm = m[1].strip()
        if nm.lower() in {"a", "the", "not", "here", "going", "coming", "sorry", "fine", "ok", "busy", "waiting"}:
            continue
        add("PERSON", m.start(1), m.end(1), nm.title() if nm.isascii() else nm, selfId=True)

    # 4) gazetteers / patterns
    for org in ORGS:
        for m in re.finditer(rf"(?<![\w]){re.escape(org)}(?![\w])", text, re.IGNORECASE):
            add("ORG", m.start(), m.end(), org)
    for loc in LOCATIONS:
        for m in re.finditer(rf"(?<![\w]){re.escape(loc)}(?![\w])", text, re.IGNORECASE):
            add("LOCATION", m.start(), m.end(), loc)
    for m in _LOC_PATTERN.finditer(text):
        g = 1 if m[1] else 2
        val = m[g]
        if val and val.split()[0].lower() not in {"the", "i", "my", "your"} and not any(val.lower() == n.lower() for n in known_names):
            add("LOCATION", m.start(g), m.end(g), val)

    # 5) statistical NER on the original if it is Latin-script (spaCy is English-only)
    nlp = _spacy_nlp()
    if nlp is not None and text.isascii():
        mapping = {"PERSON": "PERSON", "ORG": "ORG", "GPE": "LOCATION", "LOC": "LOCATION", "FAC": "LOCATION"}
        for e in nlp(text[:5000]).ents:
            if e.label_ in mapping:
                add(mapping[e.label_], e.start_char, e.end_char, e.text)

    ents.sort(key=lambda e: e["start"])
    return ents
