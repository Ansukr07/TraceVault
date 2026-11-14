from __future__ import annotations

from fastapi import FastAPI

from app.routers import agents, incident, language, nlp, ocr, parse, vectors, voice

app = FastAPI(title="TraceVault ML Service", version="0.1.0")
app.include_router(ocr.router)
app.include_router(voice.router)
app.include_router(nlp.router)
app.include_router(incident.router)
app.include_router(agents.router)
app.include_router(parse.router)
app.include_router(language.router)
app.include_router(vectors.router)


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "sarvam_configured": bool(__import__("os").getenv("SARVAM_API_KEY")),
        "paddleocr_loaded": ocr.pipeline._paddle is not None,
        "spacy_loaded": nlp.models.nlp is not None,
        "gliner_loaded": nlp.models.gliner is not None,
        "laya_loaded": incident.classifier._agent is not None,
    }
