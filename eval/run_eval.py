"""Runs the ML pipeline on the generated demo case and scores it against ground_truth.json (spec section 15).

    python eval/run_eval.py            # uses SARVAM_MOCK=true unless you export SARVAM_MOCK=false
    python eval/run_eval.py --out eval/report

Writes <out>.json and <out>.md. Needs services/ml/.venv (or any env with the ML requirements). Metrics:
  identifier F1                phones, emails, UPI IDs, handles found vs ground truth
  inconsistencies              planted types detected / false positives
  events                       ground-truth events matched within tolerance (+-5 min, or same day for date-only)
  entity resolution            ground-truth persons resolved to a single entity
  summary                      share of sentences with valid citations / NLI-supported
Voice (WER, diarization error) needs real Sarvam output and the generated voice notes; reported as skipped here.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE = ROOT / "eval" / "data" / "priya_case"
sys.path.insert(0, str(ROOT / "services" / "ml"))
FILES = [
    ("WhatsApp Chat with Rahul K.txt", "chat_export", "WhatsApp - Rahul chat"),
    ("screenshot_rahul_demand.png", "image", "Screenshot of demand"),
    ("sbi_statement_may2024.pdf", "pdf", "SBI statement May 2024"),
    ("email_from_rk.eml", "email", "Email from rk.alt"),
]
IDENT_TYPES = {"PHONE", "EMAIL", "UPI_ID", "HANDLE"}


def norm_ident(v: str) -> str:
    return v.lower().lstrip("@").replace(" ", "")


def digits10(s: str) -> str:
    return "".join(ch for ch in s if ch.isdigit())[-10:]


def run(api) -> dict:
    evidence, chunks = [], []
    for idx, (name, kind, label) in enumerate(FILES, start=1):
        r = api.post("/extract", files={"file": (name, (CASE / name).read_bytes())},
                     data={"kind": kind, "filename": name, "translateMode": "off"})
        r.raise_for_status()
        out = r.json()
        eid = f"ev{idx}"
        evidence.append({"id": eid, "idx": idx, "kind": kind, "filename": name, "sourceLabel": label, "sha256": f"sha{idx}",
                         "metadata": out["metadata"], "flags": out["flags"], "hashes": out.get("hashes", {})})
        chunks += [{**c, "id": f"E{idx}:{c['idx']}", "evidenceId": eid, "sourceType": "document"} for c in out["chunks"]]
    st = (CASE / "statement_text.txt").read_text(encoding="utf-8")
    evidence.append({"id": "ev9", "idx": 9, "kind": "statement", "filename": "statement.webm", "sourceLabel": "Your statement",
                     "sha256": "sha9", "metadata": {}, "flags": []})
    chunks.append({"id": "E9:0", "idx": 0, "evidenceId": "ev9", "text": st, "textEn": st, "lang": "en-IN", "unit": "segment",
                   "refTs": "2024-06-03T10:00:00", "locator": {"startMs": 0, "endMs": 9000}, "sourceType": "self_statement"})
    r = api.post("/nlp/enrich", json={"chunks": [{"id": c["id"], "text": c["text"], "textEn": c.get("textEn"),
                                                  "refTs": c.get("refTs"), "sender": c.get("sender")} for c in chunks]})
    r.raise_for_status()
    by = {i["id"]: i for i in r.json()["items"]}
    for c in chunks:
        c.update({k: by[c["id"]][k] for k in ("entities", "times", "severity")})
    r = api.post("/case/rebuild", json={"ownerName": "Priya", "evidence": evidence, "chunks": chunks})
    r.raise_for_status()
    case = r.json()
    r = api.post("/case/summarize", json={"llmMode": "cloud_redacted", "evidence": evidence, "chunks": chunks,
                                          "entities": case["entities"], "events": case["events"],
                                          "inconsistencies": case["inconsistencies"],
                                          "case": {"title": "Priya v. Rahul", "incidentType": "sextortion"}})
    r.raise_for_status()
    return {"chunks": chunks, "case": case, "summary": r.json()}


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0,
            "tp": tp, "fp": fp, "fn": fn}


def tparse(s):
    try:
        d = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None
    return d.replace(tzinfo=None)  # naive local times on both sides


def score(res: dict, gt: dict) -> dict:
    want = {norm_ident(i) for p in gt["persons"] for i in p.get("identifiers", [])}
    found = {norm_ident(e["text"]) for c in res["chunks"] for e in c.get("entities", []) if e["type"] in IDENT_TYPES}
    # phones come back in many formats: match on the last 10 digits
    want_p = {digits10(w) for w in want if len(digits10(w)) >= 10 and w.lstrip("+").isdigit()}
    found_p = {digits10(f) for f in found if len(digits10(f)) >= 10 and f.lstrip("+").isdigit()}
    want_o = {w for w in want if not (len(digits10(w)) >= 10 and w.lstrip("+").isdigit())}
    found_o = {f for f in found if not (len(digits10(f)) >= 10 and f.lstrip("+").isdigit())}
    ident = prf(len(want_p & found_p) + len(want_o & found_o), len(found_p - want_p) + len(found_o - want_o),
                len(want_p - found_p) + len(want_o - found_o))

    planted = [i["type"] for i in gt["inconsistencies"]]
    got = [i["type"] for i in res["case"]["inconsistencies"]]
    inc = {"planted": planted, "detected": sorted(set(got)), "caught": len([t for t in set(planted) if t in got]),
           "of": len(set(planted)), "falsePositives": sum(1 for t in got if t not in planted)}

    matched = 0
    for g in gt["events"]:
        gts = tparse(g["ts"])
        for e in res["case"]["events"]:
            ets = tparse(e.get("ts"))
            if not gts or not ets:
                continue
            date_only = len(g["ts"]) == 10
            close = ets.date() == gts.date() if date_only else abs((ets - gts).total_seconds()) <= 300
            if close and (g.get("amount") is None or e.get("amount") in (None, g["amount"])):
                matched += 1
                break
    ev = {"matched": matched, "of": len(gt["events"]), "recall": round(matched / max(1, len(gt["events"])), 3)}

    ents = [e for e in res["case"]["entities"] if e["type"] == "PERSON"]
    resolved = 0
    for p in gt["persons"]:
        al = {norm_ident(a) for a in p["aliases"]}
        hit = {e["key"] for e in ents if al & ({norm_ident(a) for a in e.get("aliases", [])} | {norm_ident(e["name"])})}
        resolved += 1 if len(hit) == 1 else 0
    er = {"resolvedAsOne": resolved, "of": len(gt["persons"])}

    sents = [s for sec in res["summary"].get("sections", []) for s in sec.get("sentences", [])]
    summ = {"sentences": len(sents),
            "cited": round(sum(1 for s in sents if s.get("citations")) / max(1, len(sents)), 3),
            "supported": round(sum(1 for s in sents if s.get("supported") is not False) / max(1, len(sents)), 3)}
    return {"identifiers": ident, "inconsistencies": inc, "events": ev, "entityResolution": er, "summary": summ,
            "voice": {"wer": "skipped (needs real Sarvam output)", "diarizationErrorRate": "skipped"}}


def markdown(m: dict, mode: str) -> str:
    i, n, e, r, s = m["identifiers"], m["inconsistencies"], m["events"], m["entityResolution"], m["summary"]
    return "\n".join([
        f"# TraceVault eval ({mode})", "",
        "| Metric | Result | Target |", "|---|---|---|",
        f"| Identifier F1 | {i['f1']} (P {i['precision']}, R {i['recall']}) | >= 0.85 |",
        f"| Planted inconsistencies caught | {n['caught']}/{n['of']} | all |",
        f"| Inconsistency false positives | {n['falsePositives']} | <= 3 |",
        f"| Events matched (+-5 min / same day) | {e['matched']}/{e['of']} ({e['recall']}) | >= 0.80 |",
        f"| Persons resolved to one entity | {r['resolvedAsOne']}/{r['of']} | all |",
        f"| Summary sentences cited | {s['cited']} | 1.0 |",
        f"| Summary sentences NLI-supported | {s['supported']} | >= 0.90 |",
        f"| Voice WER / diarization | {m['voice']['wer']} | <= 15% / <= 20% |", ""])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "eval" / "report"))
    args = ap.parse_args()
    if not (CASE / "ground_truth.json").exists():
        import subprocess
        subprocess.run([sys.executable, str(ROOT / "eval" / "generate_case.py")], check=True)
    os.environ.setdefault("SARVAM_MOCK", "true")
    os.environ.setdefault("INTERNAL_SECRET", "eval")
    os.environ.pop("ANTHROPIC_API_KEY", None)  # offline: deterministic, no cloud calls (summary uses the structured fallback)
    from fastapi.testclient import TestClient
    from app.main import app
    from app.voice import sarvam_client

    sarvam_client.reset_client()
    gt = json.loads((CASE / "ground_truth.json").read_text(encoding="utf-8"))
    with TestClient(app, headers={"x-internal-secret": os.environ["INTERNAL_SECRET"]}) as api:
        metrics = score(run(api), gt)
    mode = "SARVAM_MOCK=" + os.environ["SARVAM_MOCK"]
    Path(args.out + ".json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    Path(args.out + ".md").write_text(markdown(metrics, mode), encoding="utf-8")
    print(markdown(metrics, mode))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
