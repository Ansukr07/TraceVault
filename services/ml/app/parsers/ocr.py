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


def ocr_image(data: bytes | Any) -> dict[str, Any]:
    """`data` = encoded image bytes or a PIL image. Returns {width, height, lines, inverted}."""
    from PIL import Image, ImageOps

    img = data if hasattr(data, "size") else Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    if not available():
        return {"width": img.width, "height": img.height, "lines": [], "inverted": False, "unavailable": True}
    lines = _run(img)
    inverted = False
    # Dark mode: mean luminance low and little found → try inverted.
    import numpy as np

    mean = float(np.asarray(img.convert("L").resize((64, 64))).mean())
    if mean < 100 and len(lines) < 3:
        inv = _run(ImageOps.invert(img))
        if len(inv) > len(lines):
            lines, inverted = inv, True
    lines.sort(key=lambda ln: (ln["bbox"][1], ln["bbox"][0]))
    return {"width": img.width, "height": img.height, "lines": lines, "inverted": inverted}
