"""Fast local language identification (spec §6.3): script detection + romanized-Hindi heuristic.

Returns (lang, confidence, ambiguous). Only ambiguous Latin-script text is worth a
Sarvam text-LID call.
"""
from __future__ import annotations

import re

# Unicode block → BCP-47 code (Devanagari is ambiguous between hi/mr; default hi-IN).
_SCRIPTS = [
    ((0x0900, 0x097F), "hi-IN"),
    ((0x0980, 0x09FF), "bn-IN"),
    ((0x0A00, 0x0A7F), "pa-IN"),
    ((0x0A80, 0x0AFF), "gu-IN"),
    ((0x0B00, 0x0B7F), "od-IN"),
    ((0x0B80, 0x0BFF), "ta-IN"),
    ((0x0C00, 0x0C7F), "te-IN"),
    ((0x0C80, 0x0CFF), "kn-IN"),
    ((0x0D00, 0x0D7F), "ml-IN"),
]

# Frequent romanized Hindi function words; enough to separate Hinglish from English chat text.
_HINGLISH = set("""
hai hain ho hoon tha thi the kya kyu kyun kaise kab kaha kahan nahi nahin mat mujhe tujhe tumhe
tum aap main mai mera meri tera teri tumhara apna apni ko ka ki ke se me mein par aur ya bhi
toh to bas abhi kal aaj raat din baje paise paisa bhej bhejo de do dena lena karo karna kar
warna varna dunga dungi denge wala wali yaar bhai haan ha accha acha theek thik sab kuch kuchh
""".split())

_WORD = re.compile(r"[a-zA-Z]+")


def detect(text: str) -> tuple[str | None, float, bool]:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return None, 0.0, False
    counts: dict[str, int] = {}
    latin = 0
    for c in letters:
        o = ord(c)
        if o < 0x250:
            latin += 1
            continue
        for (lo, hi), code in _SCRIPTS:
            if lo <= o <= hi:
                counts[code] = counts.get(code, 0) + 1
                break
    if counts:
        code, n = max(counts.items(), key=lambda kv: kv[1])
        share = n / len(letters)
        if share >= 0.5:
            return code, round(min(0.99, 0.6 + share * 0.4), 2), False
    words = [w.lower() for w in _WORD.findall(text)]
    if not words:
        return None, 0.0, True
    hits = sum(w in _HINGLISH for w in words)
    ratio = hits / len(words)
    if ratio >= 0.25:
        return "hi-Latn", round(min(0.95, 0.5 + ratio), 2), ratio < 0.4
    if ratio <= 0.05:
        return "en-IN", round(min(0.95, 0.7 + (len(words) / 100)), 2), len(words) < 4
    return "en-IN", 0.55, True


def needs_translation(lang: str | None, confidence: float) -> bool:
    """English skips translation; romanized Hinglish is left to the English models unless confident."""
    if not lang or lang.startswith("en"):
        return False
    if lang == "hi-Latn":
        return confidence >= 0.75
    return True
