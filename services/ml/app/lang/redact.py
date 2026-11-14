"""PII placeholders for `*_redacted` modes (spec §5.12, §6.3).

`redact` swaps PII for ⟦TYPE_n⟧ tokens; `restore` puts it back and reports whether
every token survived the round trip unchanged.
"""
from __future__ import annotations

import re

_PATTERNS = [
    ("EMAIL", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("UPI", re.compile(r"\b[\w.-]{2,}@[a-zA-Z]{2,}\b")),
    ("URL", re.compile(r"https?://\S+")),
    ("PHONE", re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)")),
    ("ACCOUNT", re.compile(r"(?<!\d)\d{9,18}(?!\d)")),
]
_TOKEN = re.compile(r"⟦([A-Z]+)_(\d+)⟧")


def redact(text: str, extra: dict[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """`extra` maps literal strings (e.g. known person names from NER) to a type."""
    mapping: dict[str, str] = {}
    reverse: dict[str, str] = {}
    counters: dict[str, int] = {}

    def token_for(kind: str, value: str) -> str:
        if value in reverse:
            return reverse[value]
        counters[kind] = counters.get(kind, 0) + 1
        tok = f"⟦{kind}_{counters[kind]}⟧"
        mapping[tok] = value
        reverse[value] = tok
        return tok

    for value, kind in sorted((extra or {}).items(), key=lambda kv: -len(kv[0])):
        if value:
            text = text.replace(value, token_for(kind, value))
    for kind, pat in _PATTERNS:
        text = pat.sub(lambda m, k=kind: m.group(0) if _TOKEN.fullmatch(m.group(0)) else token_for(k, m.group(0)), text)
    return text, mapping


def restore(text: str, mapping: dict[str, str]) -> tuple[str, bool]:
    found = set(_TOKEN.findall(text))
    expected = {tuple(_TOKEN.fullmatch(t).groups()) for t in mapping}
    ok = found == expected
    for tok, val in mapping.items():
        text = text.replace(tok, val)
    return text, ok
