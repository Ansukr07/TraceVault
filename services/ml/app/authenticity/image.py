"""Image authenticity indicators: Error Level Analysis (ELA) heatmap, editing-software and timestamp checks.

Everything here is an *indicator for a human to look at*, never proof of forgery. ELA in particular is noisy on
screenshots and re-saved images, so a PNG result is reported with that caveat.
"""
from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image

from ..parsers.metadata import image_metadata

DISCLAIMER = "Indicators only. This is not a forensic conclusion and does not prove an image is genuine or altered."
BLOCK = 16
MAX_SIDE = 900  # heatmap preview size; the original is never touched


def _ela(img: Image.Image, quality: int = 90) -> np.ndarray:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    buf.seek(0)
    again = Image.open(buf).convert("RGB")
    a = np.asarray(img, dtype=np.int16)
    b = np.asarray(again, dtype=np.int16)
    return np.abs(a - b).max(axis=2).astype(np.float32)  # H x W, 0..255


def _blocks(ela: np.ndarray) -> np.ndarray:
    h, w = ela.shape
    hb, wb = h // BLOCK, w // BLOCK
    return ela[: hb * BLOCK, : wb * BLOCK].reshape(hb, BLOCK, wb, BLOCK).mean(axis=(1, 3))


def _components(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        stack, comp = [(int(y), int(x))], []
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            comp.append((cy, cx))
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        out.append(comp)
    return out


def _colormap(v: np.ndarray) -> np.ndarray:
    """0..1 -> RGB (dark blue, teal, yellow, red), no matplotlib needed."""
    stops = np.array([[10, 20, 60], [20, 120, 140], [240, 200, 60], [226, 60, 40]], dtype=np.float32)
    pos = np.clip(v, 0, 1) * (len(stops) - 1)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(stops) - 1)
    f = (pos - lo)[..., None]
    return (stops[lo] * (1 - f) + stops[hi] * f).astype(np.uint8)


def _heatmap_png(img: Image.Image, ela: np.ndarray) -> str:
    scale = min(1.0, MAX_SIDE / max(img.size))
    size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    base = img.resize(size, Image.LANCZOS).convert("RGB")
    p = float(np.percentile(ela, 99.0)) or 1.0
    norm = np.clip(ela / p, 0, 1) ** 0.6  # gamma lifts faint differences so the preview is readable
    heat = Image.fromarray(_colormap(norm)).resize(size, Image.BILINEAR)
    alpha = Image.fromarray((np.clip(norm * 1.6, 0.0, 0.92) * 255).astype(np.uint8)).resize(size, Image.BILINEAR)
    dimmed = Image.blend(base, Image.new("RGB", size, (0, 0, 0)), 0.35)
    out = Image.composite(heat, dimmed, alpha)
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def analyze(data: bytes) -> dict[str, Any]:
    img = Image.open(io.BytesIO(data))
    fmt = img.format
    rgb = img.convert("RGB")
    meta, flags = image_metadata(data)
    checks: list[dict[str, Any]] = []
    risk = 0.0

    # 1. Editing software / metadata consistency (strong, explainable signal)
    edit = [f for f in flags if f["type"] == "EDITED_FILE"]
    mism = [f for f in flags if f["type"] == "METADATA_MISMATCH"]
    if edit:
        risk += 60
        checks.append({"id": "editing_software", "status": "fail", "title": "Editing software recorded",
                       "summary": f"The file's metadata names an image editor ({edit[0]['value']}). The file was saved by that software after capture."})
    else:
        checks.append({"id": "editing_software", "status": "pass", "title": "Editing software",
                       "summary": "No image-editor signature found in the file metadata."})
    if mism:
        risk += 20
        checks.append({"id": "timestamps", "status": "warn", "title": "Capture and edit times differ", "summary": mism[0]["value"]})
    elif meta.get("captureTime") or meta.get("modifyTime"):
        checks.append({"id": "timestamps", "status": "pass", "title": "Metadata timestamps", "summary": "Capture and modification times are consistent."})
    else:
        checks.append({"id": "timestamps", "status": "not_applicable", "title": "Metadata timestamps",
                       "summary": "No capture or modification time in the file. Common for screenshots."})

    # 2. Error Level Analysis
    ela = _ela(rgb)
    bl = _blocks(ela)
    mu, sd = float(bl.mean()), float(bl.std())
    thr = max(mu + 3.0 * sd, 6.0)
    mask = bl > thr
    comps = sorted((c for c in _components(mask) if len(c) >= 3), key=len, reverse=True)
    regions = []
    hb, wb = bl.shape
    for c in comps[:5]:
        ys = [p[0] for p in c]
        xs = [p[1] for p in c]
        regions.append({
            "bbox": [min(xs) / wb, min(ys) / hb, (max(xs) - min(xs) + 1) / wb, (max(ys) - min(ys) + 1) / hb],
            "blocks": len(c),
            "strength": round(float(np.mean([bl[y, x] for y, x in c]) / max(mu, 0.1)), 1),
            "label": "Compression level differs from the rest of the image",
        })
    area = int(mask.sum()) / max(1, bl.size)
    lossy = fmt in ("JPEG", "MPO")
    if regions:
        risk += min(30.0, 8 + area * 400) if lossy else min(6.0, 2 + area * 100)
        note = "" if lossy else " This is a lossless image, so this indicator is weak: screenshots naturally vary."
        checks.append({"id": "ela", "status": "warn" if lossy else "info", "title": "Error level analysis", "score": round(area * 100, 2),
                       "summary": f"{len(regions)} area(s) recompressed differently from the rest of the image ({area * 100:.1f}% of it)." + note})
    else:
        checks.append({"id": "ela", "status": "pass", "title": "Error level analysis", "score": 0.0,
                       "summary": "Compression error is uniform across the image."})

    risk = max(0.0, min(100.0, risk))
    band = "high" if risk >= 60 else "medium" if risk >= 30 else "low"
    return {
        "riskIndicator": round(risk), "band": band, "checks": checks, "regions": regions,
        "heatmap": _heatmap_png(rgb, ela), "width": rgb.width, "height": rgb.height, "format": fmt,
        "software": meta.get("software"), "disclaimer": DISCLAIMER,
        "generator": {"name": "authenticity-image", "version": "0.1", "provider": "local"},
    }
