"""OCR router: English pipeline first, local-language pipeline when needed.

    image ─► English OCR (RapidOCR, on-device) ─► good Latin text? ─► done
                                           └─► poor / Indic script ─► local-language OCR
                                                                       (Google Vision → Sarvam Vision)

`provider` decides what may leave the machine:
  'local'  — English pipeline only, nothing is uploaded (default)
  'auto'   — local first; local-language engines only when the local result is poor
  'google' — Google Vision first, local as fallback
  'sarvam' — Sarvam Vision first, local as fallback
"""
from __future__ import annotations

import asyncio
import io
import os
from typing import Any

from . import english, indic
from ..schemas import OCRLine, OCRResponse

# Re-exported for health checks and older imports.
available = english.available
loaded = english.loaded
_is_poor = english.is_poor


def _indic_order() -> tuple[str, ...]:
    raw = os.environ.get("OCR_INDIC_ORDER", "google,sarvam")
    order = tuple(p.strip() for p in raw.split(",") if p.strip() in ("google", "sarvam"))
    return order or ("google", "sarvam")


def _result(img, lines, provider, usage, inverted=False, unavailable=False) -> dict[str, Any]:
    boxed = sorted((ln for ln in lines if ln.get("bbox")), key=lambda ln: (ln["bbox"][1], ln["bbox"][0]))
    out = {"width": img.width, "height": img.height, "lines": boxed, "inverted": inverted, "provider": provider, "usage": usage}
    unboxed = [ln for ln in lines if not ln.get("bbox")]
    if unboxed:
        out["textLines"] = unboxed  # page-level text without geometry (Sarvam); never given invented boxes
    if unavailable:
        out["unavailable"] = True
    return out


def _chars(lines: list[dict[str, Any]]) -> int:
    return len("".join(ln["text"] for ln in lines))


def ocr_image(data: bytes | Any, provider: str = "local") -> dict[str, Any]:
    """`data` = encoded image bytes or a PIL image. Returns {width, height, lines, inverted, provider, usage[, textLines]}."""
    from PIL import Image, ImageOps

    img = data if hasattr(data, "size") else Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    usage: list[dict[str, Any]] = []
    tried: tuple[str, ...] = ()

    if provider in ("google", "sarvam"):
        tried = (provider,)
        hit = indic.recognize(img, usage, tried)
        if hit:
            return _result(img, hit[0], hit[1], usage)

    if not english.available():
        hit = indic.recognize(img, usage, _indic_order()) if provider == "auto" else None
        if hit:
            return _result(img, hit[0], hit[1], usage)
        return _result(img, [], None, usage, unavailable=True)

    lines, inverted = english.recognize(img)
    used = "rapidocr"
    if provider in ("auto", "google", "sarvam") and english.is_poor(lines):
        hit = indic.recognize(img, usage, tuple(p for p in _indic_order() if p not in tried))
        if hit and _chars(hit[0]) > _chars(lines):
            lines, inverted, used = hit[0], False, hit[1]
    return _result(img, lines, used, usage, inverted=inverted)


# ------------------------------------------------------------------ /ocr endpoint shape
class OCRPipeline:
    """Normalised-polygon OCR response for the standalone /ocr endpoint, with an English working copy per line."""

    def __init__(self, provider: str | None = None) -> None:
        self.provider = provider or os.environ.get("OCR_PROVIDER", "auto")

    @property
    def _paddle(self):  # health-check compatibility with the services2 API
        return english._engine

    def extract(self, image_bytes: bytes, provider: str | None = None) -> OCRResponse:
        from PIL import Image

        try:
            Image.open(io.BytesIO(image_bytes)).verify()
        except Exception as exc:  # noqa: BLE001
            raise ValueError("Uploaded file is not a readable image") from exc
        res = ocr_image(image_bytes, provider or self.provider)
        from ..ingestion.language import detect, english_working_text

        w, h = max(1, res["width"]), max(1, res["height"])
        warnings: list[str] = []
        if res.get("unavailable"):
            warnings.append("No OCR engine available; install rapidocr-onnxruntime or configure GOOGLE_API_KEY / SARVAM_API_KEY.")
        for u in res["usage"]:
            if u.get("status") == "error":
                warnings.append(f"{u['provider']} OCR failed: {u.get('error')}")
        lines: list[OCRLine] = []
        for ln in res["lines"] + res.get("textLines", []):
            box = ln.get("bbox")
            poly = [[box[0] / w, box[1] / h], [box[2] / w, box[1] / h], [box[2] / w, box[3] / h], [box[0] / w, box[3] / h]] if box else []
            lang = detect(ln["text"]).get("language") or "en"
            text_en = None
            if str(lang).lower().split("-")[0] != "en":
                try:
                    text_en, _, _ = english_working_text(ln["text"], str(lang))
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Translation failed for OCR line: {exc}")
            conf = max(0.0, min(1.0, float(ln.get("conf", 0))))
            lines.append(OCRLine(text=ln["text"], bbox=poly, confidence=conf, provider=res["provider"] or "none",
                                 language=lang, textEn=text_en, lowConfidence=conf < 0.6))
        providers = [res["provider"]] if res["provider"] else []
        return OCRResponse(lines=lines, providers=providers, width=res["width"], height=res["height"], warnings=list(dict.fromkeys(warnings)))

    async def aextract(self, image_bytes: bytes, provider: str | None = None) -> OCRResponse:
        return await asyncio.to_thread(self.extract, image_bytes, provider)
