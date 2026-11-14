from __future__ import annotations

import os
import re
from dataclasses import dataclass

import phonenumbers


@dataclass
class RawMention:
    text: str
    label: str
    start: int
    end: int
    confidence: float
    normalized: str | None
    source: str


PATTERNS = [
    ("EMAIL", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I), 0.99),
    ("URL", re.compile(r"\b(?:https?://|www\.)[^\s<>]+", re.I), 0.99),
    ("UPI_ID", re.compile(r"(?<![\w.+-])[\w.-]{2,}@[a-z]{2,}(?![\w.-])", re.I), 0.97),
    ("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b", re.I), 0.99),
    ("BANK_ACCT", re.compile(r"\b(?:\d[ -]?){8,18}\d\b"), 0.76),
    ("MONEY", re.compile(r"(?:₹|\bINR\b|\bRs\.?\s*)\s*\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:k|thousand|lakh|lakhs|lac|crore)\b)?|\b\d+(?:\.\d+)?\s*(?:k|lakh|lac|crore)\b", re.I), 0.96),
    ("HANDLE", re.compile(r"(?<!\w)@[A-Za-z0-9._]{2,30}\b"), 0.9),
    ("VEHICLE_NO", re.compile(r"\b[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4}\b", re.I), 0.92),
]


def regex_mentions(text: str) -> list[RawMention]:
    found: list[RawMention] = []
    for label, pattern, confidence in PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(0).strip()
            normalized = normalize_money(value) if label == "MONEY" else value
            if label == "BANK_ACCT" and len(re.sub(r"\D", "", value)) < 10:
                continue
            found.append(RawMention(value, label, match.start(), match.end(), confidence, normalized, "regex"))
    for match in re.finditer(r"(?<!\w)(?:\+?\d[\d ()-]{7,}\d)(?!\w)", text):
        value = match.group(0)
        try:
            parsed = phonenumbers.parse(value, os.getenv("PHONE_DEFAULT_REGION", "IN"))
            if phonenumbers.is_possible_number(parsed) and phonenumbers.is_valid_number(parsed):
                found.append(RawMention(value, "PHONE", match.start(), match.end(), 0.99, phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164), "regex"))
        except phonenumbers.NumberParseException:
            pass
    return found


def normalize_money(value: str) -> str:
    cleaned = re.sub(r"[,₹\s]", "", value.lower()).replace("inr", "").replace("rs.", "").replace("rs", "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*(k|thousand|lakh|lakhs|lac|crore)?", cleaned)
    if not match:
        return value
    amount = float(match.group(1))
    factor = {"k": 1000, "thousand": 1000, "lakh": 100000, "lakhs": 100000, "lac": 100000, "crore": 10000000}.get(match.group(2) or "", 1)
    return f"INR {amount * factor:.2f}"


class NLPModels:
    def __init__(self) -> None:
        self.nlp = None
        self.gliner = None
        self.warnings: list[str] = []
        try:
            import spacy
            self.nlp = spacy.load(os.getenv("SPACY_MODEL", "en_core_web_trf"))
        except Exception as exc:
            self.warnings.append(f"spaCy model unavailable: {exc}")
        try:
            from gliner import GLiNER
            self.gliner = GLiNER.from_pretrained(os.getenv("GLINER_MODEL", "urchade/gliner_multi-v2.1"))
        except Exception as exc:
            self.warnings.append(f"GLiNER unavailable: {exc}")

    def extract(self, text: str, text_en: str | None = None) -> list[RawMention]:
        found = regex_mentions(text)  # regex spans always address the original script
        # spaCy works on the English working copy when supplied. Its offsets
        # cannot safely be exposed as original-source offsets after translation.
        spacy_text = text_en if text_en is not None else text
        if self.nlp is not None:
            for ent in self.nlp(spacy_text).ents:
                label = {"PERSON": "PERSON", "ORG": "ORG", "GPE": "LOCATION", "LOC": "LOCATION", "DATE": "DATE", "TIME": "TIME", "MONEY": "MONEY"}.get(ent.label_)
                if not label:
                    continue
                # Translated spans do not map safely to the source. Regex on
                # original text and GLiNER below still produce original offsets.
                if text_en is not None:
                    continue
                found.append(RawMention(ent.text, label, ent.start_char, ent.end_char, 0.75, normalize_money(ent.text) if label == "MONEY" else None, "spacy"))
        if self.gliner is not None:
            labels = ["person", "organization", "location", "social media handle", "vehicle number", "address", "phone number", "email"]
            try:
                for ent in self.gliner.predict_entities(text, labels, threshold=0.45):
                    label = {"person": "PERSON", "organization": "ORG", "location": "LOCATION", "social media handle": "HANDLE", "vehicle number": "VEHICLE_NO", "address": "ADDRESS", "phone number": "PHONE", "email": "EMAIL"}.get(ent["label"].lower())
                    if label:
                        found.append(RawMention(ent["text"], label, int(ent["start"]), int(ent["end"]), float(ent["score"]), None, "gliner"))
            except Exception as exc:
                self.warnings.append(f"GLiNER inference failed: {exc}")
        return merge_overlaps(found)


def merge_overlaps(mentions: list[RawMention]) -> list[RawMention]:
    priority = {"regex": 3, "gliner": 2, "spacy": 1}
    ordered = sorted(mentions, key=lambda m: (m.start, -(m.end - m.start), -priority.get(m.source, 0)))
    result: list[RawMention] = []
    for candidate in ordered:
        overlaps = [i for i, current in enumerate(result) if candidate.start < current.end and current.start < candidate.end]
        if not overlaps:
            result.append(candidate)
            continue
        best_index = max(overlaps, key=lambda i: (priority.get(result[i].source, 0), result[i].confidence))
        current = result[best_index]
        if (priority.get(candidate.source, 0), candidate.confidence) > (priority.get(current.source, 0), current.confidence):
            result[best_index] = candidate
    return sorted(result, key=lambda m: (m.start, m.end))
