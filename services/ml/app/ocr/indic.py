"""Local-language (Indic script) OCR pipeline.

Two cloud engines that read Devanagari, Kannada, Tamil, Telugu, etc., which the bundled English
model cannot:

  * Sarvam Vision (Document AI Parse job, `sarvam-vision-v1`), needs SARVAM_API_KEY
  * Google Cloud Vision DOCUMENT_TEXT_DETECTION, needs GOOGLE_API_KEY

Both send the image off this machine, so callers must only use them when the case allows it.
Lines are returned in the same shape as the English pipeline: {text, bbox:[x0,y0,x1,y1] | None, conf}.
Sarvam's page-level output often carries no geometry; those lines get bbox=None. Geometry is
never invented.
"""
from __future__ import annotations

import io
import json
import os
import time
import zipfile
from typing import Any

import httpx

from ..lang.google_cloud import GoogleError, get_google


class UsageSink:
    """Collects usage records without importing the Sarvam log type."""

    def __init__(self, out: list[dict[str, Any]]):
        self.out = out

    def add(self, **rec: Any) -> None:
        self.out.append(rec)


# ------------------------------------------------------------------ Google Vision
def google_available() -> bool:
    return get_google().available


def google_ocr(img, usage: list[dict[str, Any]]) -> dict[str, Any] | None:
    g = get_google()
    if not g.available:
        return None
    buf = io.BytesIO()
    img.save(buf, "PNG")
    try:
        return g.ocr(buf.getvalue(), usage=UsageSink(usage))
    except GoogleError as e:
        usage.append({"provider": "google", "endpoint": "vision_ocr", "status": "error", "error": str(e)[:200]})
        return None


# ------------------------------------------------------------------ Sarvam Vision
def sarvam_available() -> bool:
    return bool(os.getenv("SARVAM_API_KEY")) and os.getenv("SARVAM_MOCK", "").lower() not in ("1", "true")


def sarvam_ocr(img, usage: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Sarvam Vision via the asynchronous Document AI Parse job. Returns {lines, text} or None on failure."""
    if not sarvam_available():
        return None
    buf = io.BytesIO()
    img.save(buf, "PNG")
    try:
        data = _sarvam_job(buf.getvalue())
    except Exception as e:  # noqa: BLE001  — provider failure must fall back, not fail the request
        usage.append({"provider": "sarvam", "endpoint": "vision_parse", "status": "error", "error": f"{type(e).__name__}: {e}"[:200]})
        return None
    usage.append({"provider": "sarvam", "endpoint": "vision_parse", "model": os.getenv("SARVAM_VISION_MODEL", "sarvam-vision-v1"), "status": 200})
    lines = _sarvam_lines(data, img.width, img.height)
    return {"lines": lines, "text": "\n".join(ln["text"] for ln in lines)}


def _sarvam_job(image_bytes: bytes) -> dict:
    api_key = os.environ["SARVAM_API_KEY"]
    base = os.getenv("SARVAM_DOC_AI_URL", "https://api.sarvam.ai/doc-ai/v1/job")
    headers = {"api-subscription-key": api_key}
    with httpx.Client(timeout=60) as client:
        response = client.post(f"{base}/parse", headers=headers,
                               data={"output_format": "json", "model": os.getenv("SARVAM_VISION_MODEL", "sarvam-vision-v1")},
                               files={"file": ("image.png", image_bytes, "image/png")})
        response.raise_for_status()
        job_id = response.json().get("job_id")
        if not job_id:
            raise RuntimeError("Sarvam Vision response did not include job_id")
        deadline = time.monotonic() + float(os.getenv("SARVAM_VISION_TIMEOUT_SECONDS", "180"))
        while time.monotonic() < deadline:
            status_response = client.get(f"{base}/{job_id}/status", headers=headers)
            status_response.raise_for_status()
            status = status_response.json()
            phase = str(status.get("status", "")).lower()
            if phase in {"completed", "partially_completed"}:
                link = client.get(f"{base}/{job_id}/download-url", headers=headers)
                link.raise_for_status()
                info = link.json()
                download = client.request(str(info.get("method", "GET")).upper(), info["url"], headers=info.get("headers", {}))
                download.raise_for_status()
                return _read_job_output(download.content)
            if phase in {"failed", "rejected", "cancelled"}:
                raise RuntimeError(f"Sarvam Vision job {phase}")
            time.sleep(2)
    raise TimeoutError("Sarvam Vision job timed out")


def _sarvam_lines(data: dict, width: int, height: int) -> list[dict[str, Any]]:
    results = data.get("lines", data.get("results", []))
    if not results:
        text = data.get("text") or data.get("markdown") or data.get("content") or ""
        if not text and isinstance(data.get("pages"), list):
            text = "\n".join(str(p.get("text") or p.get("markdown") or "") for p in data["pages"])
        return [{"text": ln.strip(), "bbox": None, "conf": 0.55} for ln in str(text).splitlines() if ln.strip()]
    # Boxes come in the provider's page coordinates; rescale them to this image's pixels.
    sx = width / float(data.get("width") or width)
    sy = height / float(data.get("height") or height)
    lines: list[dict[str, Any]] = []
    for item in results:
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        box = item.get("bbox") or item.get("polygon")
        bbox = None
        if box and len(box) == 4 and isinstance(box[0], (int, float)):
            x0, y0, x1, y1 = map(float, box)
            bbox = [int(x0 * sx), int(y0 * sy), int(x1 * sx), int(y1 * sy)]
        elif box:
            xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
            bbox = [int(min(xs) * sx), int(min(ys) * sy), int(max(xs) * sx), int(max(ys) * sy)]
        lines.append({"text": text, "bbox": bbox, "conf": round(float(item.get("confidence", 0.75 if bbox else 0.55)), 3)})
    return lines


def _read_job_output(content: bytes) -> dict:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            candidates = [n for n in archive.namelist() if n.lower().endswith(".json")]
            if not candidates:
                raise RuntimeError("Sarvam Vision output ZIP contains no page JSON")
            return json.loads(archive.read(candidates[0]).decode("utf-8"))
    except zipfile.BadZipFile:
        try:
            return json.loads(content.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("Unsupported Sarvam Vision output format") from exc


# ------------------------------------------------------------------ routing
def recognize(img, usage: list[dict[str, Any]], order: tuple[str, ...] = ("google", "sarvam")) -> tuple[list[dict[str, Any]], str] | None:
    """Try the local-language engines in `order`; returns (lines, provider) from the first that reads text."""
    engines = {"google": (google_ocr, "google_vision"), "sarvam": (sarvam_ocr, "sarvam_vision")}
    for name in order:
        fn, label = engines[name]
        res = fn(img, usage)
        if res and res["lines"]:
            return res["lines"], label
    return None
