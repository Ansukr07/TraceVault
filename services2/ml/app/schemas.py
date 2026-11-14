from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class OCRLine(BaseModel):
    text: str
    bbox: list[list[float]]
    confidence: float = Field(ge=0, le=1)
    provider: str
    language: str | None = None
    lowConfidence: bool = False
    textEn: str | None = None


class OCRResponse(BaseModel):
    lines: list[OCRLine]
    providers: list[str]
    width: int
    height: int
    warnings: list[str] = Field(default_factory=list)


class TranscriptionSegment(BaseModel):
    start: float
    end: float
    text: str
    language: str | None = None
    speaker: str | None = None
    words: list[dict[str, Any]] = Field(default_factory=list)
    textEn: str | None = None


class TranscriptionResponse(BaseModel):
    language: str | None = None
    provider: str
    mode: Literal["transcribe", "translate"]
    segments: list[TranscriptionSegment]
    warnings: list[str] = Field(default_factory=list)


class EnrichChunk(BaseModel):
    id: str
    text: str
    textEn: str | None = None
    refTime: str | None = None
    locale: str | None = None


class EnrichRequest(BaseModel):
    caseId: str | None = None
    chunks: list[EnrichChunk]
    timezone: str = "Asia/Kolkata"
    includeEmbeddings: bool = False
    storeChunks: bool = True


class Mention(BaseModel):
    chunkId: str
    text: str
    label: str
    start: int
    end: int
    confidence: float = Field(ge=0, le=1)
    normalized: str | None = None
    source: str


class NormalizedTime(BaseModel):
    chunkId: str
    expression: str
    start: int
    end: int
    iso: str | None = None
    rangeEnd: str | None = None
    tsPrecision: Literal["exact", "approx", "unknown"]
    timezone: str


class EnrichResponse(BaseModel):
    mentions: list[Mention]
    times: list[NormalizedTime]
    workingTexts: dict[str, str] = Field(default_factory=dict)
    embeddings: dict[str, list[float]] = Field(default_factory=dict)
    indexedChunks: int = 0
    incident: dict[str, Any] | None = None
    warnings: list[str] = Field(default_factory=list)


class ParsedMessage(BaseModel):
    index: int
    timestamp: str | None = None
    sender: str | None = None
    text: str
    media: list[str] = Field(default_factory=list)
    locator: dict[str, Any] = Field(default_factory=dict)


class ParseMessagesResponse(BaseModel):
    format: str
    messages: list[ParsedMessage]
    dateOrder: str | None = None
    warnings: list[str] = Field(default_factory=list)


class ParsedDocumentResponse(BaseModel):
    pages: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class ParsedEmailResponse(BaseModel):
    headers: dict[str, Any]
    body: str
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class LanguageResponse(BaseModel):
    language: str | None = None
    script: str | None = None
    confidence: float | None = None
    provider: str
    warnings: list[str] = Field(default_factory=list)


class TranslationResponse(BaseModel):
    sourceLanguage: str | None = None
    targetLanguage: str
    translatedText: str
    provider: str
    warnings: list[str] = Field(default_factory=list)
