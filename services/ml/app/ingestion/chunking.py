"""Text → citable units shared by the document parsers."""
from __future__ import annotations

import re

MAX_PARAGRAPH = 800


def paragraphs(text: str) -> list[str]:
    out: list[str] = []
    for p in re.split(r"\n\s*\n", text):
        p = re.sub(r"[ \t]+", " ", p).strip()
        while len(p) > MAX_PARAGRAPH:
            cut = max(p.rfind(". ", 0, MAX_PARAGRAPH), p.rfind(" ", 0, MAX_PARAGRAPH))
            cut = cut + 1 if cut > 0 else MAX_PARAGRAPH
            out.append(p[:cut].strip())
            p = p[cut:].strip()
        if p:
            out.append(p)
    return out
