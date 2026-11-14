"""Screenshot → chat bubbles (spec I3, heuristic path).

OCR lines are grouped into blocks; a block's horizontal position gives the side
(right = the device owner, left = the contact named in the header). In-bubble times and
centered date separators give each bubble a timestamp candidate.
"""
from __future__ import annotations

import re
from typing import Any

import dateparser

TIME_RE = re.compile(r"(?<!\d)(\d{1,2})[:.](\d{2})\s?([AaPp]\.?\s?[Mm]\.?)?\s*[✓✔√]*\s*$")
STATUS_BAR = re.compile(r"^(\d{1,2}[:.]\d{2}|\d{1,3}%|LTE|4G|5G|VoLTE|Vo|WiFi|R)$", re.IGNORECASE)
DATE_SEP = re.compile(
    r"^(today|yesterday|aaj|kal|\d{1,2}\s+\w{3,9}\s+\d{4}|\w{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$",
    re.IGNORECASE,
)
UI_NOISE = re.compile(r"^(type a message|message|online|typing\.*|last seen.*|end-to-end encrypted.*)$", re.IGNORECASE)


def _blocks(lines: list[dict], width: int) -> list[dict]:
    blocks: list[dict] = []
    for ln in lines:
        x0, y0, x1, y1 = ln["bbox"]
        h = max(1, y1 - y0)
        if blocks:
            b = blocks[-1]
            bx0, by0, bx1, by1 = b["bbox"]
            overlap = min(x1, bx1) - max(x0, bx0)
            if 0 <= y0 - by1 < 0.8 * h and overlap > 0.3 * min(x1 - x0, bx1 - bx0):
                b["lines"].append(ln)
                b["bbox"] = [min(x0, bx0), by0, max(x1, bx1), max(y1, by1)]
                continue
        blocks.append({"lines": [ln], "bbox": [x0, y0, x1, y1]})
    for b in blocks:
        b["text"] = "\n".join(ln["text"] for ln in b["lines"])
        b["conf"] = round(min(ln["conf"] for ln in b["lines"]), 3)
        x0, _, x1, _ = b["bbox"]
        cx = (x0 + x1) / 2
        if (x1 - x0) > 0.85 * width:
            b["side"] = "full"
        elif abs(cx - width / 2) < 0.08 * width and (x1 - x0) < 0.5 * width:
            b["side"] = "center"
        else:
            # Margin rule: bubbles hug one edge. Wider gap on the left → right-aligned (device owner).
            b["side"] = "right" if x0 > (width - x1) + 0.05 * width else "left"
    return blocks


def parse_screenshot(ocr: dict[str, Any], reference_date: str | None = None) -> dict[str, Any]:
    width, height = ocr["width"], ocr["height"]
    lines = ocr["lines"]
    header_zone = height * 0.16
    contact = None
    body_lines = []
    header_candidates = []
    for ln in lines:
        if ln["bbox"][3] < header_zone:
            if not STATUS_BAR.match(ln["text"]) and not UI_NOISE.match(ln["text"]) and len(ln["text"]) > 1:
                header_candidates.append(ln)
        else:
            body_lines.append(ln)
    if header_candidates:
        # Contact name: the tallest text in the header zone that isn't a time or status.
        contact = max(header_candidates, key=lambda ln: (ln["bbox"][3] - ln["bbox"][1], -ln["bbox"][1]))["text"]

    bubbles = []
    current_date = reference_date
    for b in _blocks(body_lines, width):
        text = b["text"].strip()
        if UI_NOISE.match(text):
            continue
        if b["side"] == "center" and DATE_SEP.match(text):
            d = dateparser.parse(text, settings={"RELATIVE_BASE": _dt(reference_date)} if reference_date else None)
            current_date = d.date().isoformat() if d else current_date
            continue
        time_of_day = None
        m = TIME_RE.search(text)
        if m:
            h, mi, ampm = int(m[1]), int(m[2]), m[3]
            if ampm:
                h = h % 12 + (12 if ampm.lower().startswith("p") else 0)
            if h < 24 and mi < 60:
                time_of_day = f"{h:02d}:{mi:02d}"
                text = text[: m.start()].rstrip()
        if not text:
            # A time OCR'd as its own line belongs to the bubble directly above it.
            if time_of_day and bubbles and not bubbles[-1]["timeOfDay"] and b["bbox"][1] - bubbles[-1]["bbox"][3] < 60:
                prev = bubbles[-1]
                prev["timeOfDay"] = time_of_day
                prev["ts"] = f"{prev['date']}T{time_of_day}:00" if prev["date"] else None
                prev["bbox"] = [min(prev["bbox"][0], b["bbox"][0]), prev["bbox"][1], max(prev["bbox"][2], b["bbox"][2]), b["bbox"][3]]
                # The timestamp sits at the bubble's outer edge, so the side is clearer now.
                if prev["side"] in ("left", "right"):
                    x0, _, x1, _ = prev["bbox"]
                    prev["side"] = "right" if x0 > (width - x1) + 0.05 * width else "left"
                    prev["sender"] = "Me" if prev["side"] == "right" else contact
            continue
        sender = "Me" if b["side"] == "right" else (contact if b["side"] == "left" else None)
        ts = f"{current_date}T{time_of_day}:00" if current_date and time_of_day else None
        bubbles.append({
            "text": text, "bbox": b["bbox"], "conf": b["conf"], "side": b["side"], "sender": sender,
            "timeOfDay": time_of_day, "date": current_date, "ts": ts,
        })
    looks_like_chat = len(bubbles) >= 2 and sum(1 for b in bubbles if b["side"] in ("left", "right")) >= 0.6 * len(bubbles)
    return {"contact": contact, "bubbles": bubbles, "isChat": looks_like_chat}


def _dt(iso: str):
    from datetime import datetime

    return datetime.fromisoformat(iso)


def structure_ocr(ocr: dict[str, Any], reference_date: str | None = None, use_llm: bool = False) -> dict[str, Any]:
    """Chat view used by /parse/screenshot-chat: {header, messages[], isChat, warnings}.

    Geometry heuristics first. With `use_llm`, an LLM may only re-label sender/time per bubble; the
    OCR text is always kept as `rawText`, and unreadable text is never invented.
    """
    chat = parse_screenshot(ocr, reference_date)
    messages = [{"messageIdx": i, "sender": b["sender"], "side": b["side"], "text": b["text"], "rawText": b["text"],
                 "time": b["timeOfDay"], "ts": b["ts"], "bbox": b["bbox"], "confidence": b["conf"]}
                for i, b in enumerate(chat["bubbles"])]
    header = {"contact": chat["contact"]}
    warnings: list[str] = []
    if use_llm and messages:
        try:
            from ..llm.client import chat_json

            shaped = chat_json(
                "Parse OCR bubbles from a chat screenshot. Return JSON {header:{contact}, messages:[{bubbleIdx,sender,time}]}. "
                "Never invent unreadable text; set uncertain fields null.",
                {"contact": chat["contact"], "bubbles": [{"bubbleIdx": m["messageIdx"], "text": m["rawText"], "side": m["side"]} for m in messages]},
            )
            if shaped:
                header = {**header, **{k: v for k, v in (shaped.get("header") or {}).items() if v}}
                by_idx = {int(p["bubbleIdx"]): p for p in shaped.get("messages", []) if isinstance(p, dict) and "bubbleIdx" in p}
                for m in messages:
                    p = by_idx.get(m["messageIdx"], {})
                    m["sender"] = p.get("sender") or m["sender"]
                    m["time"] = p.get("time") or m["time"]
            else:
                warnings.append("Screenshot chat LLM structuring unavailable; heuristic result returned.")
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Screenshot chat LLM structuring failed: {exc}")
    return {"header": header, "messages": messages, "isChat": chat["isChat"], "warnings": warnings}
