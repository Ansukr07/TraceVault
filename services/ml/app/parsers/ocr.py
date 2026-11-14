"""OCR (spec I2): RapidOCR (PaddleOCR models on ONNX Runtime), loaded lazily.

Returns lines with bounding boxes in image pixel coordinates. Dark-mode screenshots are
handled by retrying on the inverted image when the first pass finds little text.
"""
from __future__ import annotations

import io
import threading
from typing import Any

_engine = None
_lock = threading.Lock()


def available() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except ImportError:
        return False
    return True


def loaded() -> bool:
    return _engine is not None


def _get():
    global _engine
    with _lock:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR()
    return _engine


def _run(img) -> list[dict[str, Any]]:
    import numpy as np

    result, _ = _get()(np.asarray(img))
    lines = []
    for box, text, conf in result or []:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lines.append({
            "text": text.strip(),
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "conf": round(float(conf), 3),
        })
    return [ln for ln in lines if ln["text"]]


def _is_poor(lines: list[dict[str, Any]]) -> bool:
    """The bundled Chinese/English model returns little, low-confidence or CJK junk for Kannada/Hindi text."""
    if not lines:
        return True
    text = "".join(ln["text"] for ln in lines)
    cjk = sum(1 for ch in text if "\u3400" <= ch <= "\u9fff")
    mean = sum(ln["conf"] for ln in lines) / len(lines)
    return mean < 0.6 or (cjk / max(1, len(text))) > 0.2


class _UsageSink:
    """Collects usage records without importing the Sarvam log type."""

    def __init__(self, out: list[dict[str, Any]]):
        self.out = out

    def add(self, **rec: Any) -> None:
        self.out.append(rec)


def _cloud_ocr(img, usage: list[dict[str, Any]]) -> dict[str, Any] | None:
    from ..lang.google_cloud import GoogleError, get_google

    g = get_google()
    if not g.available:
        return None
    buf = io.BytesIO()
    img.save(buf, "PNG")
    try:
        return g.ocr(buf.getvalue(), usage=_UsageSink(usage))
    except GoogleError as e:
        usage.append({"provider": "google", "endpoint": "vision_ocr", "status": "error", "error": str(e)[:200]})
        return None


def _cloud_result(img, cloud: dict[str, Any], usage: list[dict[str, Any]]) -> dict[str, Any]:
    lines = sorted(cloud["lines"], key=lambda ln: (ln["bbox"][1], ln["bbox"][0]))
    return {"width": img.width, "height": img.height, "lines": lines, "inverted": False, "provider": "google_vision", "usage": usage}


def ocr_image(data: bytes | Any, provider: str = "local") -> dict[str, Any]:
    """`data` = encoded image bytes or a PIL image. Returns {width, height, lines, inverted, provider, usage}.

    provider: 'local' (RapidOCR, nothing leaves the machine) | 'auto' (local, then Google Vision when the local
    result is poor and a key is set) | 'google' (Vision first, local as fallback). The Google options send the image
    to Google, so callers must only pass them when the case allows it.
    """
    from PIL import Image, ImageOps

    img = data if hasattr(data, "size") else Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    usage: list[dict[str, Any]] = []
    if provider == "google":
        cloud = _cloud_ocr(img, usage)
        if cloud and cloud["lines"]:
            return _cloud_result(img, cloud, usage)
    if not available():
        cloud = _cloud_ocr(img, usage) if provider == "auto" else None
        if cloud and cloud["lines"]:
            return _cloud_result(img, cloud, usage)
        return {"width": img.width, "height": img.height, "lines": [], "inverted": False, "unavailable": True, "provider": None, "usage": usage}
    lines = _run(img)
    inverted = False
    # Dark mode: mean luminance low and little found → try inverted.
    import numpy as np

    mean = float(np.asarray(img.convert("L").resize((64, 64))).mean())
    if mean < 100 and len(lines) < 3:
        inv = _run(ImageOps.invert(img))
        if len(inv) > len(lines):
            lines, inverted = inv, True
    used = "rapidocr"
    if provider in ("auto", "google") and _is_poor(lines):
        cloud = _cloud_ocr(img, usage)
        if cloud and len("".join(ln["text"] for ln in cloud["lines"])) > len("".join(ln["text"] for ln in lines)):
            lines, inverted, used = cloud["lines"], False, "google_vision"
    lines.sort(key=lambda ln: (ln["bbox"][1], ln["bbox"][0]))
    return {"width": img.width, "height": img.height, "lines": lines, "inverted": inverted, "provider": used, "usage": usage}
