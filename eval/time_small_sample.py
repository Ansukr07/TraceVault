"""Per-stage latency for a small input (one screenshot + a few sentences) against a running ML service.

Usage: services/ml/.venv/Scripts/python eval/time_small_sample.py [--repeat 3]
"""
from __future__ import annotations

import argparse
import os
import statistics
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
SHOT = ROOT / "eval" / "data" / "ananya_case" / "04_whatsapp_threats_second_sim.png"
SENTENCES = [
    "Pay 30k by Sunday otherwise the pics go to HR and your father's WhatsApp.",
    "I paid Rs 25,000 to karthik.menon@okicici on 23 September because I was scared.",
    "ನಿನ್ನ ಅಪ್ಪ-ಅಮ್ಮನಿಗೆ ಎಲ್ಲಾ ಗೊತ್ತಾಗುತ್ತೆ, ನೋಡ್ತಿರು",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--repeat", type=int, default=3)
    args = ap.parse_args()
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
    secret = os.environ.get("INTERNAL_SECRET") or os.environ.get("ML_INTERNAL_SECRET", "")
    c = httpx.Client(base_url=args.base, headers={"x-internal-secret": secret}, timeout=600)
    case_id = "timing-sample"
    chunks = [{"id": f"s{i}", "text": t} for i, t in enumerate(SENTENCES)]
    ctx = {"caseId": case_id, "scopeFiltered": True, "evidence": [{"id": "e1", "kind": "image", "filename": SHOT.name}],
           "chunks": [{**ch, "evidenceId": "e1"} for ch in chunks],
           "events": [{"id": "v1", "title": "Extortion demand", "timestamp": "2024-09-22T20:31:00", "amount": 30000, "evidenceChunkIds": ["s0"]}]}

    stages = {
        "OCR+extract 1 screenshot (local)": lambda: c.post("/extract", files={"file": (SHOT.name, SHOT.read_bytes(), "image/png")},
                                                         data={"kind": "image", "filename": SHOT.name, "ocrProvider": "local", "translateMode": "off"}),
        "OCR+extract 1 screenshot (auto+translate)": lambda: c.post("/extract", files={"file": (SHOT.name, SHOT.read_bytes(), "image/png")},
                                                                  data={"kind": "image", "filename": SHOT.name, "ocrProvider": "auto", "translateMode": "sarvam"}),
        "NER only, 3 sentences": lambda: c.post("/nlp/enrich", json={"chunks": chunks, "classifyIncident": False}),
        "embed 1 sentence": lambda: c.post("/nlp/enrich", json={"chunks": chunks[:1], "includeEmbeddings": True, "classifyIncident": False}),
        "embed+index 3 sentences": lambda: c.post("/nlp/enrich", json={"caseId": case_id, "chunks": chunks, "classifyIncident": False}),
        "vector query": lambda: c.post("/vectors/query", json={"caseId": case_id, "question": "who demanded money?", "limit": 3}),
        "System1 classify 1 sentence": lambda: c.post("/incident/classify", json={"textEn": SENTENCES[0]}),
        "agents/run (all 7)": lambda: c.post("/agents/run", json={"caseCtx": ctx}),
        "agents/investigate": lambda: c.post("/agents/investigate", json={"caseCtx": ctx, "objective": "What was demanded and paid?"}),
    }
    print(f"{'stage':45} " + " ".join(f"run{i + 1:>2}" for i in range(args.repeat)) + "   median")
    for name, call in stages.items():
        times = []
        for i in range(args.repeat):
            if name.startswith("System1"):  # defeat System1's result cache so each run is real inference
                SENTENCES[0] = SENTENCES[0].rstrip("!") + "!"
            t = time.perf_counter()
            r = call()
            times.append(time.perf_counter() - t)
            r.raise_for_status()
        print(f"{name:45} " + " ".join(f"{x:5.2f}s" for x in times) + f"   {statistics.median(times):5.2f}s")
    c.delete(f"/vectors/case/{case_id}")


if __name__ == "__main__":
    main()
