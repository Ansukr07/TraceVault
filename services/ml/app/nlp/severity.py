"""Severity / harm classification (spec N6): lexicon-based for English, Hinglish and Hindi.

Scores 0–3 with labels {threat, sexual, extortion, abuse, financial_request}. A model
(detoxify / LLM labels) can replace this later; the output shape stays the same.
"""
from __future__ import annotations

import re

_LEX = {
    "threat": r"\bkill\b|\bmurder\b|\bfinish you\b|\bdestroy\b|\bacid\b|\bruin\b|you'?ll (?:see|regret)|\bregret\b|\bhurt you\b|\bcome to your\b|\bfind you\b|"
              r"\bmaar\s*(?:dunga|denge|daalunga|dalunga|duga)\b|jaan se|dekh lena|dekh lunga|chhodunga nahi|chodunga nahi|khair nahi|pata chalega|barbaad|"
              r"मार\s*दूंगा|जान से|देख लेना|छोड़ूंगा नहीं|बर्बाद|खैर नहीं",
    "sexual": r"\bnudes?\b|\bnaked\b|\bmorph(?:ed)?\b|\bintimate\b|\bprivate (?:pics|photos|video)\b|\bsex\b|\bnangi\b|\bphotos?\b.{0,20}\bviral\b|\bviral\b.{0,20}\bphotos?\b|"
              r"\bpics?\b.{0,20}\b(?:viral|leak|send)|\bvideo\b.{0,15}\b(?:viral|leak)|नंगी|फोटो.{0,10}वायरल|वायरल.{0,10}फोटो",
    "extortion": r"\botherwise\b|\bor else\b|\bwarna\b|\bvarna\b|if you don'?t pay|\bpay (?:me )?or\b|\bleak\b|\bexpose\b|\bviral kar\w*|\bupload kar\w*|"
                 r"वरना|वायरल कर",
    "abuse": r"\bbitch\b|\bslut\b|\bwhore\b|\brandi\b|\bkutti\b|\bkutta\b|\bharami\b|\bchutiya\b|\bsaali\b|\bbastard\b|\bfuck\w*|\bidiot\b|\bstupid\b|"
             r"रंडी|कुत्ती|हरामी",
    "financial_request": r"\bsend (?:me )?(?:the )?(?:money|rs|₹|\d)|\btransfer\b|\bpay\b|\bpaise?\b|\bpaisa\b|\bbhej\w*|\bupi\b|₹|\brs\.?\s?\d|\brupe\w*|\bdeposit\b|\bfee\b|\botp\b|"
                         r"पैसे|भेजो|रुपये",
}
_RE = {k: re.compile(v, re.IGNORECASE) for k, v in _LEX.items()}


def classify(text: str, text_en: str | None = None) -> dict:
    blob = f"{text}\n{text_en or ''}"
    labels = [k for k, r in _RE.items() if r.search(blob)]
    s = set(labels)
    score = 0
    if "financial_request" in s or "abuse" in s:
        score = 1
    if "threat" in s or "sexual" in s:
        score = 2
    if ("extortion" in s and (s & {"financial_request", "sexual", "threat"})) or ("threat" in s and "sexual" in s):
        score = 3
    elif "extortion" in s:
        score = max(score, 2)
    if "abuse" in s and score >= 1 and len(s) > 1:
        score = min(3, score + 1) if score < 2 else score
    return {"score": score, "labels": labels}
