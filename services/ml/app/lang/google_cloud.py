"""Google Cloud clients over the official REST APIs, authenticated with an API key (GOOGLE_API_KEY):

  * Cloud Translation v2: text translation (used when Sarvam is unavailable, or forced with TRANSLATE_PROVIDER=google)
  * Cloud Vision DOCUMENT_TEXT_DETECTION: OCR for scripts the local engine cannot read, such as Kannada

Both send the content to Google, so callers must only use them when the case's privacy settings allow it.
Nothing here uses unofficial endpoints. The key is never logged or included in error messages.
"""
from __future__ import annotations

import base64
import io
import os
from typing import Any

import httpx

TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2"
VISION_URL = "https://vision.googleapis.com/v1/images:annotate"
MAX_VISION_BYTES = 9 * 1024 * 1024  # Vision accepts ~10 MB per inline image

# BCP-47 as used in this codebase -> Google's codes
_BASE = {"od": "or", "zh": "zh-CN"}


class GoogleError(RuntimeError):
    pass


def to_google_lang(code: str | None) -> str | None:
    """'kn-IN' -> 'kn'. None for auto-detect, and for romanized text ('hi-Latn'), which Google cannot take as a source."""
    if not code or code == "auto" or code.endswith("-Latn"):
        return None
    base = code.split("-")[0].lower()
    return _BASE.get(base, base)


class GoogleCloud:
    def __init__(self, api_key: str | None = None, *, transport: httpx.BaseTransport | None = None,
                 async_transport: httpx.AsyncBaseTransport | None = None, timeout: float = 30.0):
        self.api_key = api_key if api_key is not None else os.environ.get("GOOGLE_API_KEY", "").strip()
        self._transport = transport
        self._async_transport = async_transport
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    @staticmethod
    def _fail(r: httpx.Response, what: str) -> GoogleError:
        try:
            msg = r.json().get("error", {}).get("message", "")
        except Exception:  # noqa: BLE001
            msg = ""
        return GoogleError(f"Google {what} failed (HTTP {r.status_code}){': ' + msg[:160] if msg else ''}")

    # ------------------------------------------------------------ translation
    async def translate(self, text: str, source: str | None, target: str = "en", *, usage: Any = None) -> tuple[str, str | None]:
        """Returns (translated text, detected source language)."""
        if not self.available:
            raise GoogleError("GOOGLE_API_KEY is not set")
        body: dict[str, Any] = {"q": [text], "target": to_google_lang(target) or "en", "format": "text"}
        if (src := to_google_lang(source)):
            body["source"] = src
        async with httpx.AsyncClient(timeout=self.timeout, transport=self._async_transport) as c:
            r = await c.post(TRANSLATE_URL, params={"key": self.api_key}, json=body)
        if r.status_code != 200:
            raise self._fail(r, "translation")
        item = r.json()["data"]["translations"][0]
        if usage is not None:
            usage.add(provider="google", endpoint="translate", model="nmt", chars=len(text), status=200)
        return item["translatedText"], item.get("detectedSourceLanguage")

    # ------------------------------------------------------------ OCR
    def ocr(self, image_bytes: bytes, hints: tuple[str, ...] = ("kn", "hi", "en"), *, usage: Any = None) -> dict[str, Any]:
        """Document OCR. Returns {lines:[{text,bbox:[x0,y0,x1,y1],conf}], text, lang}. Lines are in image pixels."""
        if not self.available:
            raise GoogleError("GOOGLE_API_KEY is not set")
        content = _fit(image_bytes)
        body = {"requests": [{
            "image": {"content": base64.b64encode(content).decode()},
            "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
            "imageContext": {"languageHints": list(hints)},
        }]}
        with httpx.Client(timeout=self.timeout, transport=self._transport) as c:
            r = c.post(VISION_URL, params={"key": self.api_key}, json=body)
        if r.status_code != 200:
            raise self._fail(r, "Vision OCR")
        resp = r.json()["responses"][0]
        if "error" in resp:
            raise GoogleError(f"Google Vision OCR failed: {resp['error'].get('message', '')[:160]}")
        if usage is not None:
            usage.add(provider="google", endpoint="vision_ocr", model="document_text_detection", status=200)
        return parse_vision(resp)


def _fit(data: bytes) -> bytes:
    """Re-encode oversized images as JPEG so they fit Vision's inline limit."""
    if len(data) <= MAX_VISION_BYTES:
        return data
    from PIL import Image

    img = Image.open(io.BytesIO(data)).convert("RGB")
    img.thumbnail((4000, 4000))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def parse_vision(resp: dict[str, Any]) -> dict[str, Any]:
    """fullTextAnnotation -> line records. A line ends at a LINE_BREAK / EOL_SURE_SPACE break on its last symbol."""
    full = resp.get("fullTextAnnotation") or {}
    lines: list[dict[str, Any]] = []
    langs: dict[str, float] = {}
    for page in full.get("pages", []):
        for lang in page.get("property", {}).get("detectedLanguages", []):
            langs[lang["languageCode"]] = langs.get(lang["languageCode"], 0) + lang.get("confidence", 0)
        for block in page.get("blocks", []):
            for para in block.get("paragraphs", []):
                text, xs, ys, confs = "", [], [], []
                for word in para.get("words", []):
                    for p in word.get("boundingBox", {}).get("vertices", []):
                        xs.append(p.get("x", 0))
                        ys.append(p.get("y", 0))
                    if "confidence" in word:
                        confs.append(word["confidence"])
                    for sym in word.get("symbols", []):
                        text += sym.get("text", "")
                        brk = sym.get("property", {}).get("detectedBreak", {}).get("type")
                        if brk == "SPACE":
                            text += " "
                        elif brk in ("EOL_SURE_SPACE", "LINE_BREAK"):
                            if text.strip() and xs:
                                lines.append(_line(text, xs, ys, confs))
                            text, xs, ys, confs = "", [], [], []
                        # HYPHEN joins the word across lines; UNKNOWN adds nothing
                if text.strip() and xs:
                    lines.append(_line(text, xs, ys, confs))
    lang = max(langs.items(), key=lambda kv: kv[1])[0] if langs else None
    return {"lines": lines, "text": "\n".join(ln["text"] for ln in lines), "lang": lang}


def _line(text: str, xs: list[int], ys: list[int], confs: list[float]) -> dict[str, Any]:
    return {"text": text.strip(), "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "conf": round(sum(confs) / len(confs), 3) if confs else 0.9}


_client: GoogleCloud | None = None


def get_google() -> GoogleCloud:
    global _client
    if _client is None:
        _client = GoogleCloud()
    return _client
