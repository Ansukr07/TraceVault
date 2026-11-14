# TraceVault ML service

Stateless FastAPI service. It never touches the database or storage: callers send bytes or a
scope-filtered case snapshot and persist the JSON it returns. All routes require `X-Internal-Secret`.

## Architecture (matches `tracevault-architecture.mermaid`)

```
upload ─► ingestion ─► OCR / STT ─► language (English working copy) ─► NLP ─► System1 ─► agents ─► case / report
           app/ingestion  app/ocr      app/ingestion/language.py         app/nlp  app/models   app/agents
                          app/voice    app/lang (batch, redaction)                 system1.py
```

| Layer | Package | What it does |
|---|---|---|
| Ingestion | `app/ingestion/` | `whatsapp`, `chat_exports` (Telegram / Instagram / Takeout), `screenshot_chat`, `pdf`, `email`, `metadata`, `language`; `extract.py` dispatches per evidence kind for `/extract`. |
| OCR | `app/ocr/` | Two pipelines. **English**: `english.py`, RapidOCR (PaddleOCR models, ONNX) on-device. **Local language**: `indic.py`, Google Vision then Sarvam Vision for Indic scripts. `pipeline.py` routes between them. |
| Voice | `app/voice/` | Sarvam Saaras STT with segmentation and diarization; local faster-whisper fallback. |
| Language | `app/ingestion/language.py`, `app/lang/` | Script / Hinglish detection, English working copy (Sarvam Translate, else Google), PII redaction for cloud calls. |
| NLP | `app/nlp/` | Rule-first NER (UPI, IFSC, phone, money, …) + optional spaCy, time normalisation, severity, BGE-M3 `embeddings.py`, case-scoped Chroma `vector_store.py`. |
| System1 | `app/models/system1.py` | Open-source model layer (Laya). Incident-type extraction (multi-label) and an advisory review of agent output. |
| Agents | `app/agents/` | LangGraph agents: planner, evidence quality, RAG retrieval, financial, knowledge graph + relationships, replay, evidence gaps, report. Read-only over the supplied snapshot. |
| Case | `app/case/` | Entity resolution, events, timeline, graph, inconsistency rules, summaries, Q&A, narrative. |

### OCR providers
`provider` decides what may leave the machine: `local` (English pipeline only, default for `/extract`),
`auto` (local first, local-language engines only when the local result is poor or non-Latin),
`google` / `sarvam` (that engine first, local fallback). Sarvam's page-level text has no geometry, so it
is returned as `textLines` and becomes `ocr_line` chunks; boxes are never invented.

### System1
* `POST /incident/classify` — `{textEn}` → per-label scores for `harassment`, `financial_fraud`, `scams`,
  `upi_bank_fraud`; `other` when nothing passes. Raw Laya scores are uncalibrated, so labels stay empty and
  `needsOwnerReview=true` until `LAYA_CALIBRATION_VALIDATED=true`.
* `/agents/investigate` runs System1 on the snapshot first. When the caller gave no incident type, its
  labels steer the planner and the evidence-gap checklist (caller labels are never overridden). After the
  agents run, `system1Review` flags disagreements (undeclared labels, financial agent not run, failed
  agents). Review is advisory and never edits agent output.
* With `HF_TOKEN` set, inference is hosted on Hugging Face; otherwise the local `laya` runtime is used.
  `/nlp/enrich` only sends text to the hosted model with `classifyIncident=true`.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /extract` | Per-evidence chunked extraction (chat, image, audio, pdf, email, archive). Used by the Node pipeline. |
| `POST /parse/whatsapp`, `/parse/telegram`, `/parse/instagram`, `/parse/takeout`, `/parse/pdf`, `/parse/screenshot-chat`, `/parse/eml`, `POST /metadata` | Format-specific views. |
| `POST /ocr` | OCR with normalised polygons and per-line English working copy. |
| `POST /transcribe`, `/voice/transcribe-query`, `/tts` | Speech. |
| `POST /lang/detect`, `/lang/translate`, `/translate` | Language. `/lang/detect` takes `{items:[…]}` or `{text}`. |
| `POST /nlp/enrich` | NER + times + severity (`items[]`), plus `mentions`, `times`, `workingTexts`, optional `embeddings`, Chroma indexing when `caseId` is given, and System1 `incident`. |
| `POST /vectors/query`, `DELETE /vectors/case/{id}` | Case-scoped semantic search. |
| `POST /incident/classify`, `/incident/review` | System1. |
| `GET /agents`, `POST /agents/run`, `/agents/investigate`, `/agents/rag`, `/agents/evidence-quality` | Investigation agents. `caseCtx` must have `caseId` and `scopeFiltered=true`. |
| `POST /case/rebuild`, `/case/summarize`, `/case/ask`, `/case/narrative`, `/report/pdf`, `/authenticity/image` | Case-level analysis and outputs. |
| `GET /health` | Engines, providers, models, agents. |

## Run

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:INTERNAL_SECRET = "replace-with-a-long-random-secret"
uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m pytest -q
```

Configuration is in `.env.example`. The agents router is skipped (and `/health` says so) if LangGraph is
not installed; the rest of the service still runs.
