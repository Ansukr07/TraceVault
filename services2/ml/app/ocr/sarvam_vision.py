from __future__ import annotations

import os
import asyncio
import zipfile
import io
import time

import httpx

from app.ocr.pipeline import RawLine


def recognize_image(image_bytes: bytes) -> list[RawLine]:
    """Call Sarvam Vision and normalize its OCR response to polygon lines.

    The endpoint and model are configurable because Sarvam's Vision API contract
    may evolve independently of the STT API.
    """
    api_key = os.getenv("SARVAM_API_KEY")
    if not api_key:
        raise RuntimeError("SARVAM_API_KEY is not configured")
    base = os.getenv("SARVAM_DOC_AI_URL", "https://api.sarvam.ai/doc-ai/v1/job")
    headers = {"api-subscription-key": api_key}
    with httpx.Client(timeout=60) as client:
        response = client.post(f"{base}/parse", headers=headers, data={"output_format": "json", "model": os.getenv("SARVAM_VISION_MODEL", "sarvam-vision-v1")}, files={"file": ("image.png", image_bytes, "image/png")})
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
                download_info = link.json()
                method = str(download_info.get("method", "GET")).upper()
                download = client.request(method, download_info["url"], headers=download_info.get("headers", {}))
                download.raise_for_status()
                data = _read_job_output(download.content)
                break
            if phase in {"failed", "rejected", "cancelled"}:
                raise RuntimeError(f"Sarvam Vision job {phase}: {status}")
            time.sleep(2)
        else:
            raise TimeoutError("Sarvam Vision job timed out")
    results = data.get("lines", data.get("results", []))
    if not results:
        text = data.get("text") or data.get("markdown") or data.get("content") or ""
        if not text and isinstance(data.get("pages"), list):
            text = "\n".join(str(page.get("text") or page.get("markdown") or "") for page in data["pages"])
        return [RawLine(line.strip(), [], 0.55, "sarvam_vision") for line in str(text).splitlines() if line.strip()]
    lines: list[RawLine] = []
    for item in results:
        text = str(item.get("text", "")).strip()
        box = item.get("bbox") or item.get("polygon")
        if not text:
            continue
        if not box:
            lines.append(RawLine(text, [], float(item.get("confidence", 0.55)), "sarvam_vision"))
            continue
        if len(box) == 4 and isinstance(box[0], (int, float)):
            x1, y1, x2, y2 = map(float, box)
            box = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
        # Sarvam page-level output may not carry OCR polygons. Keep its box only
        # when a box is actually provided; bbox-less text is not fabricated.
        image_width, image_height = float(data.get("width", 1)), float(data.get("height", 1))
        normalized = [[float(p[0]) / image_width, float(p[1]) / image_height] for p in box]
        lines.append(RawLine(text, normalized, float(item.get("confidence", 0.75)), "sarvam_vision"))
    return lines


async def arecognize_image(image_bytes: bytes) -> list[RawLine]:
    """Run the synchronous Document AI client without blocking the event loop."""
    return await asyncio.to_thread(recognize_image, image_bytes)


def _read_job_output(content: bytes) -> dict:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            candidates = [name for name in archive.namelist() if name.lower().endswith(".json")]
            if not candidates:
                raise RuntimeError("Sarvam Vision output ZIP contains no page JSON")
            import json
            return json.loads(archive.read(candidates[0]).decode("utf-8"))
    except zipfile.BadZipFile:
        import json
        try:
            return json.loads(content.decode("utf-8"))
        except Exception as exc:
            raise RuntimeError("Unsupported Sarvam Vision output format") from exc
