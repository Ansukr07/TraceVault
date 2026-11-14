from __future__ import annotations

import io
import asyncio
import logging
import os
import re
from dataclasses import dataclass

from PIL import Image, ImageOps

from app.schemas import OCRLine, OCRResponse
from app.ingestion.language import detect, english_working_text

log = logging.getLogger(__name__)
DEVANAGARI = re.compile(r"[\u0900-\u097f]")


@dataclass
class RawLine:
    text: str
    bbox: list[list[float]]
    confidence: float
    provider: str


class OCRPipeline:
    """English-first PaddleOCR with selective Sarvam Vision fallback."""

    def __init__(self) -> None:
        self._paddle = None
        self._paddle_error: str | None = None

    def _get_paddle(self):
        if self._paddle is None and self._paddle_error is None:
            try:
                from paddleocr import PaddleOCR

                self._paddle = PaddleOCR(
                    use_angle_cls=True,
                    lang=os.getenv("PADDLEOCR_LANG", "en"),
                    show_log=False,
                )
            except Exception as exc:  # model/runtime may be absent in a dev install
                self._paddle_error = str(exc)
                log.warning("PaddleOCR unavailable: %s", exc)
        return self._paddle

    def extract(self, image_bytes: bytes) -> OCRResponse:
        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception as exc:
            raise ValueError("Uploaded file is not a readable image") from exc
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        # Preserve originals; use a contrast-normalized copy for dark-mode screenshots.
        gray = ImageOps.grayscale(image)
        histogram = gray.histogram()
        dark_ratio = sum(histogram[:96]) / max(width * height, 1)
        processed = ImageOps.invert(gray).convert("RGB") if dark_ratio > 0.72 else image
        raw: list[RawLine] = []
        warnings: list[str] = []

        paddle = self._get_paddle()
        if paddle is not None:
            try:
                result = paddle.ocr(processed, cls=True)
                for page in result or []:
                    for item in page or []:
                        if not item or len(item) < 2:
                            continue
                        box, recognition = item[0], item[1]
                        text, score = recognition[0], recognition[1]
                        raw.append(RawLine(str(text).strip(), [[float(x) / width, float(y) / height] for x, y in box], float(score), "paddleocr"))
            except Exception as exc:
                warnings.append(f"PaddleOCR failed: {exc}")
        else:
            warnings.append("PaddleOCR is unavailable; install its optional runtime and English model.")

        needs_sarvam = self._needs_sarvam(raw)
        if needs_sarvam:
            try:
                from app.ocr.sarvam_vision import recognize_image

                sarvam_lines = recognize_image(image_bytes)
                raw = self._merge_lines(raw, sarvam_lines)
            except Exception as exc:
                warnings.append(f"Sarvam Vision fallback unavailable or failed: {exc}")

        lines = []
        for line in raw:
            if not line.text:
                continue
            lang_info = detect(line.text)
            lang = lang_info.get("language") or "en"
            text_en = None
            if str(lang).lower().split("-")[0] != "en":
                try:
                    text_en, _, _ = english_working_text(line.text, str(lang))
                except Exception as exc:
                    warnings.append(f"Translation failed for OCR line: {exc}")
            lines.append(OCRLine(
                text=line.text,
                bbox=line.bbox,
                confidence=max(0.0, min(1.0, line.confidence)),
                provider=line.provider,
                language=lang,
                textEn=text_en,
                lowConfidence=line.confidence < 0.6,
            ))
        providers = list(dict.fromkeys(line.provider for line in lines))
        return OCRResponse(lines=lines, providers=providers, width=width, height=height, warnings=warnings)

    async def aextract(self, image_bytes: bytes) -> OCRResponse:
        """Run OCR and remote fallback without blocking an async request handler."""
        return await asyncio.to_thread(self.extract, image_bytes)

    @staticmethod
    def _needs_sarvam(lines: list[RawLine]) -> bool:
        if not lines:
            return True
        devanagari = any(DEVANAGARI.search(line.text) for line in lines)
        low_conf = any(line.confidence < 0.6 for line in lines)
        return devanagari or low_conf

    @staticmethod
    def _merge_lines(primary: list[RawLine], secondary: list[RawLine]) -> list[RawLine]:
        merged = list(primary)
        for candidate in secondary:
            if not candidate.bbox:
                # Page-level Vision text has no reliable line geometry. Keep it
                # as a low-confidence OCR line for escalation, never invent a box.
                merged.append(candidate)
                continue
            cx, cy = _center(candidate.bbox)
            overlap = None
            for index, existing in enumerate(merged):
                ex, ey = _center(existing.bbox)
                if abs(cx - ex) < 0.035 and abs(cy - ey) < 0.02:
                    overlap = index
                    break
            if overlap is None:
                merged.append(candidate)
            elif candidate.confidence > merged[overlap].confidence or DEVANAGARI.search(candidate.text):
                merged[overlap] = candidate
        return sorted(merged, key=lambda item: (_center(item.bbox)[1], _center(item.bbox)[0]))


def _center(box: list[list[float]]) -> tuple[float, float]:
    return (sum(point[0] for point in box) / len(box), sum(point[1] for point in box) / len(box))
