import os
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.responses import JSONResponse

# Load ../../.env for local dev (no extra dependency).
_env = Path(__file__).resolve().parents[3] / ".env"
if _env.exists():
    for line in _env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.split(" #")[0].strip())

from .parsers import ocr  # noqa: E402
from .routers import case, extract, voice  # noqa: E402  (env must be loaded first)
from .voice import local_whisper  # noqa: E402
from .voice.sarvam_client import get_client  # noqa: E402

app = FastAPI(title="TraceVault ML", docs_url=None, redoc_url=None)
app.include_router(voice.router)
app.include_router(extract.router)
app.include_router(case.router)


@app.middleware("http")
async def internal_secret(request: Request, call_next):
    expected = os.environ.get("INTERNAL_SECRET", "")
    if not expected or request.headers.get("x-internal-secret") != expected:
        return JSONResponse({"error": {"code": "FORBIDDEN", "message": "Forbidden"}}, status_code=403)
    return await call_next(request)


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
    return JSONResponse({"error": detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    return JSONResponse({"error": {"code": "VALIDATION", "message": str(exc.errors()[:3])}}, status_code=422)


_sarvam_health: dict = {"at": 0.0, "value": None}
SARVAM_HEALTH_TTL_S = 300


@app.get("/health")
async def health():
    def tool(env: str, default: str) -> bool:
        return shutil.which(os.environ.get(env, default)) is not None

    client = get_client()
    if _sarvam_health["value"] is None or time.monotonic() - _sarvam_health["at"] > SARVAM_HEALTH_TTL_S:
        _sarvam_health["value"] = await client.ping()
        _sarvam_health["at"] = time.monotonic()

    return {
        "status": "ok",
        "tools": {"ffmpeg": tool("FFMPEG_PATH", "ffmpeg"), "tesseract": tool("TESSERACT_PATH", "tesseract")},
        "providers": {
            "sarvam": {"configured": bool(client.cfg.api_key), "mock": client.cfg.mock,
                       "sttModel": client.cfg.stt_model, **_sarvam_health["value"]},
            "claude": {"configured": bool(os.environ.get("ANTHROPIC_API_KEY"))},
        },
        "models": {"localWhisper": {"installed": local_whisper.available(), "loaded": local_whisper.loaded()},
                   "ocr": {"installed": ocr.available(), "loaded": ocr.loaded(), "engine": "rapidocr"}},
    }
