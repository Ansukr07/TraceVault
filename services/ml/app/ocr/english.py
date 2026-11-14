"""English / Latin-script OCR pipeline (spec I2): RapidOCR (PaddleOCR models on ONNX Runtime).

Runs entirely on this machine. Loaded lazily and shared across requests. Returns lines with
bounding boxes in image pixel coordinates: {text, bbox:[x0,y0,x1,y1], conf}.
"""
from __future__ import annotations

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


def recognize(img) -> tuple[list[dict[str, Any]], bool]:
    """Returns (lines, inverted). Dark-mode screenshots are retried on the inverted image when little is found."""
    from PIL import ImageOps
    import numpy as np

    lines = _run(img)
    mean = float(np.asarray(img.convert("L").resize((64, 64))).mean())
    if mean < 100 and len(lines) < 3:
        inv = _run(ImageOps.invert(img))
        if len(inv) > len(lines):
            return inv, True
    return lines, False


def is_poor(lines: list[dict[str, Any]]) -> bool:
    """The bundled Chinese/English model returns little, low-confidence or CJK junk for Indic scripts."""
    if not lines:
        return True
    text = "".join(ln["text"] for ln in lines)
    cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿")
    mean = sum(ln["conf"] for ln in lines) / len(lines)
    return mean < 0.6 or (cjk / max(1, len(text))) > 0.2
