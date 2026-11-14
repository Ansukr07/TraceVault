# TraceVault

AI-powered digital evidence intelligence platform (Build Beyond'26, PS 3.2). Turns scattered digital evidence
(WhatsApp, screenshots, voice notes, PDFs, email) into a sealed, verifiable, cited case file.
Product spec: [spec.md](spec.md) (wins over [prd.md](prd.md) where they differ).

## Run it (no Docker)

Prerequisites: Node 20, Python 3.11, MongoDB 7 as a replica set (or a free Atlas cluster), ffmpeg, Tesseract 5.
Full setup, including the replica-set step: spec.md section 13.

```bash
npm install
cd services/ml && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && cd ../..
npm run keys:generate
cp .env.example .env   # then add SARVAM_API_KEY / ANTHROPIC_API_KEY (both optional: offline fallbacks exist)
npm run seed:demo
npm run dev            # web :5173, api :4000, ml :8000
```

Demo box: `npm run build -w apps/web && pm2 start ecosystem.config.cjs`.

## Layout

| Path | What |
|---|---|
| `apps/web` | React + Vite SPA |
| `apps/api` | Express API, RBAC, sealing, audit chain, Mongo-backed job runner |
| `services/ml` | FastAPI: parsers, OCR, Sarvam voice, NLP, case intelligence |
| `eval` | Demo case generator and `run_eval.py` scorer |
| `tools/verify_bundle` | Offline verifier for exported evidence bundles |

## Checks

```bash
npm test                                   # API (integration tests skip without a MongoDB replica set)
services/ml/.venv/Scripts/python -m pytest services/ml/tests
services/ml/.venv/Scripts/python eval/run_eval.py    # scores the demo case, writes eval/report.{json,md}
python tools/verify_bundle/verify.py <unzipped bundle>
```
