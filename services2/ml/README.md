# TraceVault ML service

Stateless FastAPI extraction endpoints for OCR, speech transcription, and chunk-level NLP enrichment.

## Run

From `services/ml`, create and activate a Python 3.11 virtual environment, install the base dependencies, install the desired model runtimes, then run:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:INTERNAL_SECRET = "replace-with-a-long-random-secret"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

PaddleOCR, spaCy, GLiNER, and faster-whisper are heavyweight optional packages and are installed according to the target CPU/GPU environment. Load the spaCy English transformer model with `python -m spacy download en_core_web_trf`. PyMuPDF handles PDFs; `langid` improves Latin-script language detection. Set `SARVAM_API_KEY` for Sarvam OCR/STT/translation and `LLM_API_KEY` (or `GROQ_API_KEY`) for Groq. The default LLM model is `qwen/qwen3.8-27b`. Audio requests default to Saaras v4, can translate segments to English, and fall back to local faster-whisper when configured. The OCR fallback is attempted for Devanagari or any PaddleOCR line below 0.6 confidence.

All extraction endpoints accept multipart bytes; the service does not access the database or storage. Supply `X-Internal-Secret` when `INTERNAL_SECRET` is set.

## Endpoints

- `POST /ocr` — multipart `file`; returns text lines with image-coordinate polygons and confidence.
- `POST /transcribe` — multipart `file`; form fields `provider=sarvam|local`, `mode=transcribe|translate`, `diarize`, `allow_fallback`, and optional `translate_to_english`.
- `POST /parse/whatsapp` — multipart `.txt` or `.zip`; parses multiline Android/iOS exports, date order, media placeholders, and ZIP media as linked child-evidence payloads.
- `POST /parse/screenshot-chat` — multipart image; OCR plus bubble grouping, side-based sender heuristic, header guess, optional Groq/Qwen structuring fallback, and raw OCR retention.
- `POST /parse/pdf` — multipart PDF; extracts text by page with 300-DPI OCR for pages with fewer than 50 text characters.
- `POST /parse/eml` — multipart EML; headers, plain-text body, and recursive attachment payloads.
- `POST /metadata` — multipart file; EXIF/GPS, PDF metadata, EML headers, size, MIME, and upload time.
- `POST /parse/telegram`, `/parse/instagram`, `/parse/takeout` — multipart JSON exports normalized to message chunks and locators.
- `POST /lang/detect` and `/lang/translate` — script/language detection and Sarvam Mayura translation to an English working copy.
- `POST /nlp/enrich` — JSON `{caseId?,chunks:[{id,text,textEn?,refTime?,locale?}], timezone?, includeEmbeddings?, storeChunks?}`. Non-English chunks are translated to an English working copy with Sarvam Translate when `textEn` is omitted. NER mentions and optional embeddings use that English copy; response `workingTexts` makes mention offsets reproducible. Set `storeChunks=true` with `caseId` to upsert chunks into the local ChromaDB collection. The response also includes an incident route using Laya over English text plus extracted entity context.
- `POST /vectors/query` — JSON `{caseId,question,limit?}`; BGE-M3 semantic search restricted to that case.
- `DELETE /vectors/case/{case_id}` — delete all indexed chunks for a case.
- `POST /incident/classify` — JSON `{textEn, threshold?}`; returns multi-label scores for harassment, financial fraud, scams, and UPI/bank fraud. `other` is the abstention/fallback primary label.
- `POST /agents/run` — JSON `{caseCtx, agents?}`; asynchronously runs selected LangGraph agents and returns JSON for the Node caller to persist.
- `POST /agents/investigate` — JSON `{caseCtx, objective}`; creates a plan, selects applicable agents, runs them synchronously, and returns plan plus results.
- `POST /agents/rag` — JSON `{caseCtx, question}`; cited retrieval answer or explicit abstention.
- `POST /agents/evidence-quality` — JSON `{caseCtx, evidenceId?, question?}`; checks visual/text evidence metadata and extraction signals, then retrieves related chunks from the same case scoped vector index. `caseCtx` must include the scope filtered evidence and chunk snapshot.
- `GET /health` — process and model configuration status.

NLP follows PRD §10.4–10.5: deterministic validators first (Indian E.164 phone normalization, email, URL, UPI, IFSC/account, INR amounts, handles and vehicle numbers), then spaCy and GLiNER with overlap priority regex > GLiNER > spaCy. Date parsing uses each chunk's reference time, locale date order, past preference, and the requested case timezone.

LLM settings: `LLM_PROVIDER=groq`, `LLM_MODEL=qwen/qwen3.8-27b`, `LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_API_KEY` (or `GROQ_API_KEY`), and `LLM_TIMEOUT_SECONDS`. The shared OpenAI-compatible client is in `app/llm/client.py`; agents should call it rather than embedding provider-specific requests.

Incident taxonomy follows the implementation update: `harassment`, `financial_fraud`, `scams`, and `upi_bank_fraud` are independently scored so multiple labels may apply. With `HF_TOKEN` set, the classifier creates a Hugging Face `InferenceClient` using `HF_PROVIDER` (default `hf-inference`) and calls the hosted `LAYA_MODEL` (default `convaiinnovations/laya`). Without a token, it falls back to the local Laya runtime. Low-confidence and unavailable-model results fall back to `other` and request Owner review. Laya probabilities are treated as uncalibrated by default; set `LAYA_CALIBRATION_VALIDATED=true` only after fitting and evaluating calibration on a held-out, case-level dataset. The classifier consumes `textEn`, not source-language text.

Configure `HF_TOKEN` in the service environment, then query one classification with:

```powershell
$body = @{ textEn = "The caller threatened to publish private photos unless I sent money." } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/incident/classify -ContentType "application/json" -Headers @{ "X-Internal-Secret" = $env:INTERNAL_SECRET } -Body $body
```

Translation uses `SARVAM_TRANSLATE_MODEL=sarvam-translate:v1` (up to 2,000 characters per request, chunked for longer OCR/STT/NLP text) and requires `SARVAM_API_KEY`. OCR preserves source text and attaches `textEn` when translation succeeds; STT does the same by default. Install `FlagEmbedding` in the target CPU/GPU environment to enable `BAAI/bge-m3` dense embeddings. ChromaDB persists under `CHROMA_PERSIST_DIRECTORY` (default `./data/chroma`), stores English text plus source text and case/chunk metadata, and uses cosine similarity. RAG validates vector hits against the caller-supplied scoped snapshot before returning citations. Back up and protect the Chroma directory as case data; deleting a case through the vector endpoint removes its indexed chunks.

## LangGraph agents

Agents are grouped by purpose under `app/agents/`: `investigation.py` (financial, evidence gaps, RAG retrieval), `graph_analysis.py` (combined knowledge graph and relationship analysis, chronological replay), `reporting.py` (report and Sarvam statement extraction), and `orchestration.py` (objective planning and dynamic selection). OCR extraction and Sarvam Vision fallback live in the OCR pipeline, not an investigation agent. Agent graphs expose synchronous and asynchronous entry points; FastAPI uses `ainvoke(...)` through async runner functions. All graph inputs require `caseCtx.caseId` and `caseCtx.scopeFiltered=true`; agents only inspect that supplied snapshot. They have no DB, filesystem, or mutating tools. Results are JSON; Node persists them.

The orchestrator selects known agents from the objective, evidence kinds, and incident labels. Graph analysis can link explicitly supplied cross-modal chunk matches and builds replay items from timed events. Support and contradiction scores are reported only when present in `caseCtx`; report sentences are never marked supported without a support score, and missing checks remain flagged. This keeps the layer evidence-backed without fabricating NLI or multimodal model outputs.

Available agents: metadata analysis, evidence quality, financial investigation, evidence gap, RAG retrieval, combined knowledge graph and relationship analysis, investigation replay, and report generation. Evidence quality checks report readable-text, image dimensions, timestamp, crop, and OCR-confidence signals when those fields exist; retrieved related chunks are validated against the supplied case snapshot. The assistant does not independently verify visual authenticity or image appearance, so users should review the original. Financial statement extraction has an optional Sarvam Extract adapter in `app/agents/reporting.py`; it uses the asynchronous Document AI job API and requires Sarvam credentials. Sarvam Extract returns schema-guided structured data, so transaction-row extraction is appropriate when available; keep source files and row citations in the caller's snapshot.

## Provider note

Sarvam STT follows the documented `/speech-to-text` multipart API. Sarvam Vision 2.1 uses the Document AI asynchronous Parse job flow (`SARVAM_DOC_AI_URL`) with model ID `sarvam-vision-v1`; page-level text is retained without inventing per-line geometry, and PaddleOCR supplies normalized line boxes. Provider failures are returned as warnings.

Ingestion coverage: I1, I2, I4–I8, I9 and I10 have parser/endpoint implementations. Screenshot parsing (I3) uses geometry heuristics and an optional Groq JSON fallback. WhatsApp ZIP and EML endpoints return child attachment bytes as base64 so Node can persist each child as linked evidence. These endpoints are not yet connected to an upload/job runner in this repository.
