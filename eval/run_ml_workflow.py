"""End-to-end ML workflow test on the synthetic Ananya Rao case, against a running ML service.

    ingestion (/extract: chat, 7 screenshots via OCR, PDF statement, email)
    → STT (Sarvam TTS → /extract audio: English + Hindi voice notes)
    → NLP (/nlp/enrich: NER, times, BGE-M3 embeddings, Chroma indexing)
    → vector search (/vectors/query)
    → System1 (Laya incident classification)
    → case model (/case/rebuild)
    → agents (/agents/run, /agents/rag, /agents/evidence-quality) and orchestration (/agents/investigate)

Usage:  services/ml/.venv/Scripts/python eval/run_ml_workflow.py [--base http://127.0.0.1:8000]
Writes every stage's raw output to eval/out/ananya_workflow/ and prints a scored summary vs ground_truth.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
CASE_DIR = ROOT / "eval" / "data" / "ananya_case"
OUT = ROOT / "eval" / "out" / "ananya_workflow"
CASE_ID = "ananya-demo"


def load_env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.split(" #")[0].strip())


class Run:
    def __init__(self, base: str):
        load_env()
        secret = os.environ.get("INTERNAL_SECRET") or os.environ.get("ML_INTERNAL_SECRET", "")
        self.c = httpx.Client(base_url=base, headers={"x-internal-secret": secret}, timeout=3600)
        self.results: list[tuple[str, bool, str]] = []
        OUT.mkdir(parents=True, exist_ok=True)

    def save(self, name: str, data) -> None:
        (OUT / f"{name}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")

    def check(self, stage: str, ok: bool, detail: str) -> None:
        self.results.append((stage, bool(ok), detail))
        print(f"  [{'PASS' if ok else 'FAIL'}] {stage}: {detail}")

    def post(self, path: str, **kw):
        t = time.perf_counter()
        r = self.c.post(path, **kw)
        dt = time.perf_counter() - t
        if r.status_code >= 400:
            raise RuntimeError(f"{path} → HTTP {r.status_code}: {r.text[:400]}")
        return (r.json() if "json" in r.headers.get("content-type", "") else r.content), dt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--ocr", default="auto", help="local | auto | google | sarvam")
    args = ap.parse_args()
    run = Run(args.base)
    truth = json.loads((CASE_DIR / "ground_truth.json").read_text(encoding="utf-8"))

    health = run.c.get("/health").json()
    run.save("00_health", health)
    print("== health:", json.dumps({k: health.get(k) for k in ("providers", "agents")}, default=str)[:400])

    # ------------------------------------------------------------ 1. ingestion + OCR
    print("\n== 1. ingestion + OCR")
    evidence, chunks = [], []

    def ingest(path: Path, kind: str, mime: str, **form):
        out, dt = run.post("/extract", files={"file": (path.name, path.read_bytes(), mime)},
                           data={"kind": kind, "filename": path.name, "translateMode": "sarvam", "ocrProvider": args.ocr, **form})
        eid = f"E{len(evidence) + 1}"
        run.save(f"10_extract_{eid}_{path.stem[:30]}", out)
        meta = out.get("metadata", {})
        evidence.append({"id": eid, "idx": len(evidence), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "metadata": meta,
                         "filename": path.name, "kind": kind, "mimeType": mime, "width": meta.get("width"), "height": meta.get("height"),
                         "capturedAt": meta.get("captureTime") or meta.get("sentAt") or meta.get("createdAt"),
                         "flags": out.get("flags", []), "ocrProvider": meta.get("ocrProvider"),
                         "ocrConfidence": min((c.get("conf", 1) for c in out["chunks"] if c.get("conf") is not None), default=None),
                         "chunkIds": [], "hashes": out.get("hashes")})
        for c in out["chunks"]:
            cid = f"{eid}:{c['idx']}"
            evidence[-1]["chunkIds"].append(cid)
            chunks.append({**c, "id": cid, "chunkId": cid, "evidenceId": eid, "sourceType": "self_statement" if kind == "statement" else "document"})
        return out, dt

    out, dt = ingest(CASE_DIR / "WhatsApp Chat with Karthik Menon.txt", "chat_export", "text/plain")
    run.check("whatsapp export", len(out["chunks"]) >= 10, f"{len(out['chunks'])} messages, participants {out['metadata'].get('participants')} ({dt:.1f}s)")

    for png in sorted(CASE_DIR.glob("0*.png")):
        out, dt = ingest(png, "image", "image/png")
        text = " ".join(c["text"] for c in out["chunks"])
        langs = sorted({c.get("lang") for c in out["chunks"] if c.get("lang")})
        translated = sum(1 for c in out["chunks"] if c.get("textEn") and c.get("textEn") != c.get("text"))
        flags = [f["type"] for f in out.get("flags", [])]
        run.check(f"OCR {png.name}", len(text) > 40,
                  f"{len(out['chunks'])} chunks via {out['metadata'].get('ocrProvider')}, chat={out['artifact']['screenshotChat']['isChat']}, "
                  f"langs={langs}, translated={translated}, flags={flags}, {dt:.1f}s")
    edited = next(e for e in evidence if "EDITED" in e["filename"])
    run.check("EDITED_FILE flag on 06", any(f["type"] == "EDITED_FILE" for f in edited["flags"]), str([f["type"] for f in edited["flags"]]))
    kannada = [c for c in chunks if (c.get("lang") or "").startswith("kn")]
    run.check("local-language OCR (Kannada)", bool(kannada), f"{len(kannada)} Kannada chunks; sample: {kannada[0]['text'][:60] if kannada else '-'} → {kannada[0].get('textEn', '')[:60] if kannada else ''}")

    out, dt = ingest(CASE_DIR / "hdfc_statement_sep2024.pdf", "pdf", "application/pdf")
    run.check("PDF statement", any("25,000" in c["text"] or "25000" in c["text"] for c in out["chunks"]), f"{len(out['chunks'])} units, ocrPages={out['metadata'].get('ocrPages')}")
    out, dt = ingest(CASE_DIR / "email_from_anon.eml", "email", "message/rfc822")
    run.check("email", out["metadata"].get("from", "").find("anon.truth.blr") >= 0, f"{len(out['chunks'])} chunks, sentAt={out['metadata'].get('sentAt')}")

    # ------------------------------------------------------------ 2. STT (synthesised voice notes)
    print("\n== 2. STT")
    voice_notes = [
        ("voice_statement_en.wav", "en-IN", (CASE_DIR / "statement_text.txt").read_text(encoding="utf-8")[:480]),
        ("voice_note_hi.wav", "hi-IN", "मैंने पच्चीस सितंबर को पच्चीस हज़ार रुपये भेजे क्योंकि मैं बहुत डरी हुई थी। अब वह तीस हज़ार और माँग रहा है।"),
    ]
    for name, lang, text in voice_notes:
        try:
            wav, dt_tts = run.post("/tts", json={"text": text, "lang": lang})
            (OUT / name).write_bytes(wav)
            out, dt = ingest(OUT / name, "statement" if "statement" in name else "audio", "audio/wav", voiceProvider="sarvam")
            said = " ".join(c["text"] for c in out["chunks"])
            en = " ".join(c.get("textEn") or "" for c in out["chunks"])
            run.check(f"STT {lang}", len(said) > 20, f"provider={out['metadata'].get('provider')}, lang={out['metadata'].get('lang')}, "
                      f"{len(out['chunks'])} segments ({dt_tts:.1f}s TTS, {dt:.1f}s STT): {said[:70]!r} → EN {en[:70]!r}")
        except Exception as exc:  # noqa: BLE001
            run.check(f"STT {lang}", False, str(exc)[:200])

    # ------------------------------------------------------------ 3. NLP + embeddings + Chroma
    print("\n== 3. NLP pipeline + embeddings")
    run.c.delete(f"/vectors/case/{CASE_ID}")
    body = {"caseId": CASE_ID, "storeChunks": True, "classifyIncident": True, "knownNames": ["Ananya Rao", "Karthik Menon"],
            "chunks": [{"id": c["id"], "text": c["text"], "textEn": c.get("textEn"), "refTs": c.get("refTs"), "sender": c.get("sender")} for c in chunks if c.get("text")]}
    nlp, dt = run.post("/nlp/enrich", json=body)
    run.save("30_nlp_enrich", nlp)
    labels = {}
    for m in nlp["mentions"]:
        labels.setdefault(m["label"], set()).add(m["normalized"] or m["text"])
    found_ids = {str(v).lower().replace(" ", "") for vals in labels.values() for v in vals}
    want = {i.lower().replace(" ", "") for p in truth["persons"] for i in p["identifiers"]}
    hit = {w for w in want if any(w.lstrip("+") in f or w in f for f in found_ids)}
    run.check("NER identifiers", len(hit) >= len(want) // 2, f"{len(nlp['mentions'])} mentions; ground-truth identifiers found {len(hit)}/{len(want)}: {sorted(hit)}")
    run.check("time normalisation", len(nlp["times"]) > 5, f"{len(nlp['times'])} times")
    run.check("embeddings + Chroma", nlp["indexedChunks"] > 0, f"indexed {nlp['indexedChunks']} chunks ({dt:.1f}s); warnings={[w for w in nlp['warnings'] if 'mbedding' in w][:1]}")
    inc = nlp.get("incident") or {}
    run.check("System1 via /nlp/enrich", inc.get("provider") not in (None, "unavailable", "laya_error", "hf_error"),
              f"provider={inc.get('provider')}, scores={inc.get('scores')}, primary={inc.get('primary')}")

    for q in ("Who threatened to send private photos to HR?", "How much money was paid and to which UPI ID?", "ಹಣ ಕಳುಹಿಸಿ"):
        try:
            res, dt = run.post("/vectors/query", json={"caseId": CASE_ID, "question": q, "limit": 3})
            run.save(f"31_vectors_{q[:12]}", res)
            top = res["results"][0] if res["results"] else {}
            run.check(f"vector search: {q[:40]}", bool(res["results"]), f"top {top.get('chunkId')} d={top.get('distance', 0):.3f}: {str(top.get('textEn'))[:80]!r}")
        except Exception as exc:  # noqa: BLE001
            run.check(f"vector search: {q[:40]}", False, str(exc)[:200])

    # ------------------------------------------------------------ 4. System1 (Laya)
    print("\n== 4. System1 (Laya)")
    s1, dt = run.post("/incident/classify", json={"textEn": (CASE_DIR / "statement_text.txt").read_text(encoding="utf-8")})
    run.save("40_system1", s1)
    top2 = sorted(s1.get("scores", {}).items(), key=lambda kv: -kv[1])[:2]
    run.check("System1 classify", s1["provider"] in ("laya", "hf-inference"), f"provider={s1['provider']} ({dt:.1f}s), top={top2}, labels={s1['labels']}, review={s1['needsOwnerReview']}")

    # ------------------------------------------------------------ 5. case model
    print("\n== 5. case rebuild")
    by_id = {i["id"]: i for i in nlp["items"]}
    ev_in = [{"id": e["id"], "idx": e["idx"], "kind": e["kind"], "filename": e["filename"], "sourceLabel": e["filename"], "sha256": e["sha256"],
              "metadata": e["metadata"], "flags": e["flags"], "hashes": e.get("hashes") or {}} for e in evidence]
    case_chunks = [{"id": c["id"], "idx": c["idx"], "evidenceId": c["evidenceId"], "text": c.get("text") or "", "textEn": c.get("textEn"),
                    "lang": c.get("lang"), "sender": c.get("sender"), "refTs": c.get("refTs"), "unit": c.get("unit"), "locator": c.get("locator") or {},
                    "entities": by_id.get(c["id"], {}).get("entities", []), "times": by_id.get(c["id"], {}).get("times", []),
                    "severity": by_id.get(c["id"], {}).get("severity") or {"score": 0, "labels": []}, "sourceType": c.get("sourceType"),
                    "timeOfDay": c.get("timeOfDay"), "conf": c.get("conf")} for c in chunks]
    case, dt = run.post("/case/rebuild", json={"ownerName": "Ananya Rao", "evidence": ev_in, "chunks": case_chunks})
    run.save("50_case_rebuild", case)
    incs = sorted({i.get("type") for i in case["inconsistencies"]})
    want_incs = {i["type"] for i in truth["inconsistencies"]}
    run.check("case model", case["events"] and case["entities"], f"{len(case['entities'])} entities, {len(case['events'])} events, {len(case['duplicates'])} duplicate groups ({dt:.1f}s)")
    run.check("inconsistencies vs ground truth", want_incs <= set(incs), f"found {incs}; expected {sorted(want_incs)}")

    # ------------------------------------------------------------ 6. agents + orchestration
    print("\n== 6. agents + orchestration")
    ent_ids = {e["key"]: e for e in case["entities"]}
    ctx = {
        "caseId": CASE_ID, "scopeFiltered": True,
        "evidence": [{k: v for k, v in e.items() if k != "metadata"} for e in evidence],
        "chunks": [{"id": c["id"], "evidenceId": c["evidenceId"], "text": c["text"], "textEn": c.get("textEn")} for c in chunks],
        "entities": [{"id": e["key"], "type": "Person" if e["type"] == "PERSON" else "Account", "name": e.get("name"),
                      "chunkIds": e.get("mentionChunkIds", []), "citations": e.get("mentionChunkIds", [])[:5]} for e in case["entities"]],
        "events": [{"id": ev["key"], "title": ev.get("title"), "description": ev.get("descriptionEn") or ev.get("description") or ev.get("title"),
                    "timestamp": ev.get("ts"), "category": "payment" if ev.get("amount") else ev.get("category"), "amount": ev.get("amount"),
                    "entityIds": [k for k in (ev.get("actors") or []) + (ev.get("targets") or []) if k in ent_ids],
                    "evidenceChunkIds": ev.get("citations") or [], "severity": ev.get("severity"), "confidence": ev.get("confidence")} for ev in case["events"]],
        "statements": [{"evidenceId": e["id"], "transactions": _rows(chunks, e["id"])} for e in evidence if e["kind"] == "pdf"],
        "question": "How much did Ananya pay and to which UPI ID?",
    }
    run.save("60_case_ctx", ctx)
    agents, dt = run.post("/agents/run", json={"caseCtx": ctx})
    run.save("61_agents_run", agents)
    for cp in agents["checkpoints"]:
        out = agents["results"][cp["agent"]]
        run.check(f"agent {cp['agent']}", cp["status"] == "completed", _agent_summary(cp["agent"], out))
    rv = agents.get("system1Review") or {}
    run.check("System1 review of agents", rv.get("status") in ("reviewed", "skipped"), f"status={rv.get('status')}, flags={[f['code'] for f in rv.get('flags', [])]}")

    rag, dt = run.post("/agents/rag", json={"caseCtx": ctx, "question": "Who threatened to send private photos to HR and parents?"})
    run.save("62_agents_rag", rag)
    snips = rag["result"].get("retrievalSnippets") or []
    run.check("RAG agent", bool(snips) and rag["result"].get("validated", False), f"{len(snips)} cited snippets, first {snips[0]['citation'] if snips else '-'}: {snips[0]['text'][:70]!r}" if snips else rag["result"].get("reason", ""))
    eq, dt = run.post("/agents/evidence-quality", json={"caseCtx": ctx, "evidenceId": edited["id"]})
    run.save("63_agents_quality", eq)
    run.check("evidence-quality agent (06 EDITED)", eq["result"]["status"] == "reviewed", f"findings={[f['code'] for f in eq['result']['findings']]}, related={len(eq['result']['relatedEvidence'])}")

    inv, dt = run.post("/agents/investigate", json={"caseCtx": {k: v for k, v in ctx.items() if k != "question"}, "objective": "Investigate the harassment and extortion: who did what, when, and what payments were made?"})
    run.save("64_agents_investigate", inv)
    run.check("orchestration plan", bool(inv["plan"]["selectedAgents"]), f"selected {inv['plan']['selectedAgents']} labels={inv['plan']['incidentLabels']} ({dt:.1f}s)")
    run.check("orchestration System1", inv.get("system1") is not None, f"system1={ {k: inv['system1'].get(k) for k in ('provider', 'primary', 'labels')} if inv.get('system1') else None}, review flags={[f['code'] for f in (inv.get('system1Review') or {}).get('flags', [])]}")

    # ------------------------------------------------------------ summary
    passed = sum(ok for _, ok, _ in run.results)
    print(f"\n== {passed}/{len(run.results)} checks passed. Raw outputs: {OUT}")
    run.save("99_summary", [{"stage": s, "ok": ok, "detail": d} for s, ok, d in run.results])
    return 0 if passed == len(run.results) else 1


def _rows(chunks: list[dict], eid: str) -> list[dict]:
    """Statement rows from PDF units: amount, UPI id, debit/credit."""
    rows = []
    for c in chunks:
        if c["evidenceId"] != eid:
            continue
        upi = re.search(r"[\w.-]+@[a-z]+", c["text"])
        amt = re.findall(r"\b\d{1,3}(?:,\d{2,3})+(?:\.\d{2})?\b|\b\d{4,6}\.\d{2}\b", c["text"])
        if upi and amt:
            rows.append({"amount": amt[0].replace(",", ""), "upiId": upi.group(0), "direction": "debit" if re.search(r"/DR/|Debit: \d", c["text"]) else "credit",
                         "text": c["text"], "citations": [c["id"]]})
    return rows


def _agent_summary(name: str, out: dict) -> str:
    if out.get("error"):
        return f"error {out['error']}"
    if name == "financial_investigation":
        return f"loss ₹{out['lossTotal']}, matched {sum(r['matched'] for r in out['ledger'])}/{len(out['ledger'])} payment events, findings={[f['code'] for f in out['findings']]}"
    if name == "knowledge_graph":
        return f"{len(out['nodes'])} nodes, {len(out['edges'])} edges, citationsValid={out['citationsValid']}, central={out['centralFigures'][:2]}"
    if name == "investigation_replay":
        return f"{len(out['items'])} timed items, first {out['items'][0]['timestamp'] if out['items'] else '-'}"
    if name == "evidence_gap":
        return f"{len(out['gaps'])} checklist rows for {out['evaluatedIncidentTypes']}"
    if name == "report_generation":
        return f"{len(out['sections'])} sections, {len(out['evidenceIndex'])} evidence rows"
    if name == "rag_investigation":
        return f"{len(out.get('retrievalSnippets') or [])} snippets, abstained={out.get('abstained')}"
    if name == "evidence_quality":
        return f"{len(out['findings'])} findings over {len(out['reviewedEvidenceIds'])} items, {len(out['relatedEvidence'])} related"
    return json.dumps(out)[:120]


if __name__ == "__main__":
    sys.exit(main())
