from __future__ import annotations

import json
from typing import Any

from app.llm.client import chat


def structure_ocr(ocr_lines: list[dict[str, Any]], use_llm: bool = True) -> dict[str, Any]:
    """Group OCR boxes into chat bubbles; retain OCR text and source boxes."""
    ordered = sorted(ocr_lines, key=lambda line: (_center(line.get("bbox", []))[1], _center(line.get("bbox", []))[0]))
    groups: list[list[dict[str, Any]]] = []
    for line in ordered:
        box = line.get("bbox", [])
        center = _center(box)
        if groups and abs(center[1] - _center(groups[-1][-1].get("bbox", []))[1]) < 0.035:
            groups[-1].append(line)
        else:
            groups.append([line])
    bubbles = []
    for index, group in enumerate(groups):
        raw_text = " ".join(str(line.get("text", "")) for line in group).strip()
        boxes = [line.get("bbox") for line in group if line.get("bbox")]
        bubbles.append({"bubbleIdx": index, "rawText": raw_text, "text": raw_text, "bbox": _union(boxes), "confidence": min((float(line.get("confidence", 0)) for line in group), default=0), "side": _side(_union(boxes))})
    header = _guess_header(bubbles)
    header_idx = header.get("bubbleIdx")
    messages = [{"sender": header.get("contact") if bubble["side"] == "left" else "self" if bubble["side"] == "right" else None, "side": bubble["side"], "text": bubble["text"], "rawText": bubble["rawText"], "time": None, "bbox": bubble["bbox"], "confidence": bubble["confidence"], "messageIdx": bubble["bubbleIdx"]} for bubble in bubbles if bubble["text"] and bubble["bubbleIdx"] != header_idx]
    warnings = []
    if use_llm and bubbles:
        try:
            shaped = _llm_parse(bubbles)
            if shaped:
                header = {**header, **shaped.get("header", {})}
                by_idx = {int(item["bubbleIdx"]): item for item in shaped.get("messages", []) if "bubbleIdx" in item}
                for message in messages:
                    proposed = by_idx.get(message["messageIdx"], {})
                    message["sender"] = proposed.get("sender", message["sender"])
                    message["text"] = proposed.get("text", message["rawText"])
                    message["time"] = proposed.get("time")
                    message["rawText"] = message["rawText"]
        except Exception as exc:
            warnings.append(f"Screenshot chat LLM fallback unavailable: {exc}")
    return {"header": header, "messages": messages, "warnings": warnings}


def _llm_parse(bubbles: list[dict[str, Any]]) -> dict[str, Any]:
    prompt = {"bubbles": [{"bubbleIdx": b["bubbleIdx"], "text": b["rawText"], "side": b["side"]} for b in bubbles]}
    raw = chat([{"role": "system", "content": "Parse OCR bubbles from a chat screenshot. Return JSON with header.contact and messages [{bubbleIdx,sender,text,time}]. Never invent unreadable text; preserve words, set uncertain fields null."}, {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}], response_format={"type": "json_object"}, temperature=0)
    return json.loads(raw)


def _center(box: list) -> tuple[float, float]:
    if not box:
        return 0, 0
    return sum(float(p[0]) for p in box) / len(box), sum(float(p[1]) for p in box) / len(box)


def _union(boxes: list[list[list[float]]]) -> list[list[float]]:
    points = [p for box in boxes for p in box]
    if not points:
        return []
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [[min(xs), min(ys)], [max(xs), min(ys)], [max(xs), max(ys)], [min(xs), max(ys)]]


def _side(box: list[list[float]]) -> str | None:
    if not box:
        return None
    x, _ = _center(box)
    return "left" if x < .42 else "right" if x > .58 else "center"


def _guess_header(bubbles: list[dict[str, Any]]) -> dict[str, Any]:
    for bubble in bubbles[:5]:
        if bubble["side"] == "center" and len(bubble["rawText"]) < 60:
            return {"contact": bubble["rawText"], "bubbleIdx": bubble["bubbleIdx"]}
    return {"contact": None, "bubbleIdx": None}
