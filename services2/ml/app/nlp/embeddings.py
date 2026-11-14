from __future__ import annotations

import os
from typing import Any


class EmbeddingModel:
    """Lazy BGE-M3 dense embedding adapter."""

    def __init__(self) -> None:
        self.model = None
        self.error: str | None = None

    def _load(self):
        if self.model is None and self.error is None:
            try:
                from FlagEmbedding import BGEM3FlagModel

                self.model = BGEM3FlagModel(os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3"), use_fp16=os.getenv("EMBEDDING_USE_FP16", "false").lower() == "true")
            except Exception as exc:
                self.error = str(exc)
        return self.model

    def encode(self, texts: list[str]) -> dict[str, Any]:
        if not texts:
            return {"embeddings": [], "model": os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")}
        model = self._load()
        if model is None:
            raise RuntimeError(f"Embedding model unavailable: {self.error}")
        result = model.encode(texts, return_dense=True, return_sparse=False, return_colbert_vecs=False)
        return {"embeddings": result["dense_vecs"].tolist(), "model": os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")}


embedder = EmbeddingModel()
