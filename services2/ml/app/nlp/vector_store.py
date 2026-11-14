from __future__ import annotations

import os
from typing import Any


class CaseVectorStore:
    """Persistent Chroma collection with mandatory case-scoped filtering."""

    def __init__(self) -> None:
        self._collection = None
        self._error: str | None = None

    def _get_collection(self):
        if self._collection is None and self._error is None:
            try:
                import chromadb

                path = os.getenv("CHROMA_PERSIST_DIRECTORY", "./data/chroma")
                client = chromadb.PersistentClient(path=path)
                self._collection = client.get_or_create_collection(
                    name=os.getenv("CHROMA_COLLECTION", "tracevault_chunks"),
                    metadata={"hnsw:space": "cosine"},
                )
            except Exception as exc:
                self._error = str(exc)
        if self._collection is None:
            raise RuntimeError(f"ChromaDB unavailable: {self._error}")
        return self._collection

    @staticmethod
    def _key(case_id: str, chunk_id: str) -> str:
        return f"{case_id}::{chunk_id}"

    def upsert(self, case_id: str, rows: list[dict[str, Any]]) -> int:
        if not case_id:
            raise ValueError("caseId is required to index chunks")
        if not rows:
            return 0
        collection = self._get_collection()
        collection.upsert(
            ids=[self._key(case_id, row["chunkId"]) for row in rows],
            embeddings=[row["embedding"] for row in rows],
            documents=[row["textEn"] for row in rows],
            metadatas=[{
                "caseId": case_id,
                "chunkId": row["chunkId"],
                "sourceText": row.get("sourceText", "")[:8000],
                "language": str(row.get("language") or "unknown"),
            } for row in rows],
        )
        return len(rows)

    def query(self, case_id: str, query_embedding: list[float], limit: int = 8) -> list[dict[str, Any]]:
        if not case_id:
            raise ValueError("caseId is required for scoped vector search")
        result = self._get_collection().query(
            query_embeddings=[query_embedding],
            n_results=max(1, min(int(limit), 50)),
            where={"caseId": case_id},
            include=["documents", "metadatas", "distances"],
        )
        ids = (result.get("ids") or [[]])[0]
        docs = (result.get("documents") or [[]])[0]
        metas = (result.get("metadatas") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
        return [
            {"chunkId": meta.get("chunkId"), "textEn": doc, "sourceText": meta.get("sourceText", ""), "distance": distance}
            for doc, meta, distance in zip(docs, metas, distances)
            if meta.get("caseId") == case_id
        ]

    def delete_case(self, case_id: str) -> int:
        if not case_id:
            raise ValueError("caseId is required")
        collection = self._get_collection()
        found = collection.get(where={"caseId": case_id}, include=[])
        ids = found.get("ids", [])
        if ids:
            collection.delete(ids=ids)
        return len(ids)


vector_store = CaseVectorStore()
