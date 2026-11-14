"""System1 — open-source model layer (Laya, `convaiinnovations/laya`).

Sits after ingestion + embeddings and before the investigation agents:

    ingestion → OCR / STT → English working copy → NER / embeddings → System1 → agents

Two jobs:
  1. Incident-type extraction: independent multi-label scores over the English working copy for
     harassment, financial_fraud, scams, upi_bank_fraud (`other` is the abstention label).
  2. Agent review: re-scores the case snapshot and checks the agents' outputs against it (labels the
     planner used, evidence-gap coverage, financial findings vs fraud labels). Review flags are
     advisory; they never change agent output.

With HF_TOKEN set, inference runs on Hugging Face's hosted Inference API (HF_PROVIDER, default
hf-inference). Without it, the local Laya runtime is used. Laya probabilities are treated as
uncalibrated unless LAYA_CALIBRATION_VALIDATED=true, in which case labels stay empty and Owner
review is requested.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass
from typing import Any

LABELS = ("harassment", "financial_fraud", "scams", "upi_bank_fraud")
DEFAULT_THRESHOLD = 0.60  # Must be replaced by held-out calibration for deployment.
MAX_CHARS = 12000

LABEL_DESCRIPTIONS = {
    "harassment": "Repeated unwanted contact, threats, stalking, abuse, sextortion, or coercion.",
    "financial_fraud": "Deception or impersonation intended to cause financial loss or obtain money.",
    "scams": "Fraudulent offers, phishing, impersonation, or other deceptive schemes, whether or not money moved.",
    "upi_bank_fraud": "Unauthorized UPI, bank-account, card, or payment transaction or credential misuse.",
}

# One binary decision per taxonomy option supports true multi-label assignment.
QUESTIONS = {
    label: {
        "type": "noul",
        "instructions": f"Does the case evidence indicate {description}",
        "criteria": {"false": "not indicated by the evidence", "true": "indicated by the evidence"},
        "labels": {"false": "not indicated", "true": "indicated"},
    }
    for label, description in LABEL_DESCRIPTIONS.items()
}


@dataclass
class IncidentClassification:
    labels: list[str]
    scores: dict[str, float]
    primary: str
    confidence: float
    needs_owner_review: bool
    provider: str
    warnings: list[str]

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["needsOwnerReview"] = d.pop("needs_owner_review")
        return d


def _unavailable(provider: str, warning: str) -> IncidentClassification:
    return IncidentClassification([], {}, "other", 0.0, True, provider, [warning])


class System1:
    """Lazy, thread-safe Laya runtime with a small result cache (same text → same scores)."""

    def __init__(self, cache_size: int = 256) -> None:
        self._agent = None
        self._error: str | None = None
        self._client = None
        self._client_error: str | None = None
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, tuple[str, dict[str, Any]]] = OrderedDict()
        self._cache_size = cache_size
        self._cache_lock = threading.Lock()
        self._last_warning: str | None = None

    @property
    def model_name(self) -> str:
        return os.getenv("LAYA_MODEL", "convaiinnovations/laya")

    @property
    def loaded(self) -> bool:
        return self._agent is not None or self._client is not None

    def _load_hf_client(self):
        with self._lock:
            if self._client is None and self._client_error is None:
                try:
                    from huggingface_hub import InferenceClient

                    self._client = InferenceClient(provider=os.getenv("HF_PROVIDER", "hf-inference"), api_key=os.environ["HF_TOKEN"])
                except Exception as exc:  # noqa: BLE001
                    self._client_error = str(exc)
        return self._client

    def _load(self):
        with self._lock:
            if self._agent is None and self._error is None:
                try:
                    from laya import Agent

                    self._agent = Agent(model_id_or_path=self.model_name, token=os.getenv("HF_TOKEN") or None)
                except Exception as exc:  # noqa: BLE001
                    self._error = str(exc)
        return self._agent

    def _answers(self, text: str, allow_hosted: bool = True) -> tuple[str, dict[str, Any]] | IncidentClassification:
        """(provider, raw per-label answers) or an unavailable result."""
        hosted = allow_hosted and bool(os.getenv("HF_TOKEN"))
        key = hashlib.sha256(f"{self.model_name}|{hosted}|{text}".encode()).hexdigest()
        with self._cache_lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        hosted_warning = None
        out = None
        if hosted:
            client = self._load_hf_client()
            if client is None:
                hosted_warning = f"Hugging Face client unavailable: {self._client_error}"
            else:
                try:
                    # Raw task call: InferenceClient.text_classification() has no `question` parameter.
                    raw = client.post(json={"inputs": text, "parameters": {"question": QUESTIONS}}, model=self.model_name, task="text-classification")                         if hasattr(client, "post") else _hf_post(self.model_name, text)
                    out = ("hf-inference", _hf_answers(json.loads(raw) if isinstance(raw, (bytes, str)) else raw))
                except Exception as exc:  # noqa: BLE001
                    hosted_warning = f"Hugging Face Laya inference failed ({_short(exc)}); used local Laya."
        if out is None:
            agent = self._load()
            if agent is None:
                msg = f"Local Laya unavailable: {self._error}"
                return _unavailable("unavailable", f"{hosted_warning} {msg}".strip() if hosted_warning else msg)
            try:
                out = ("laya", agent.system_one({"text": text}, QUESTIONS).get("answers", {}))
            except Exception as exc:  # noqa: BLE001
                return _unavailable("laya_error", f"Laya classification failed: {exc}")
        if hosted_warning:
            self._last_warning = hosted_warning
        with self._cache_lock:
            self._cache[key] = out
            if len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return out

    # ------------------------------------------------------------ 1. incident-type extraction
    def classify(self, text_en: str, threshold: float | None = None, allow_hosted: bool = True) -> IncidentClassification:
        if not text_en.strip():
            raise ValueError("textEn must contain text")
        threshold = threshold if threshold is not None else float(os.getenv("INCIDENT_CONFIDENCE_THRESHOLD", DEFAULT_THRESHOLD))
        if not 0 <= threshold <= 1:
            raise ValueError("threshold must be in [0, 1]")
        got = self._answers(text_en[:MAX_CHARS], allow_hosted)
        if isinstance(got, IncidentClassification):
            return got
        provider, answers = got
        try:
            scores = {label: _positive_probability(answers.get(label, {})) for label in LABELS}
        except Exception as exc:  # noqa: BLE001
            return _unavailable(f"{provider}_error", f"Laya output could not be read: {exc}")
        warnings: list[str] = [self._last_warning] if self._last_warning and provider == "laya" else []
        # Raw Laya probabilities are not called calibrated; calibration is opt-in.
        calibrated = os.getenv("LAYA_CALIBRATION_VALIDATED", "false").lower() == "true"
        if not calibrated:
            warnings.append("Laya confidence is uncalibrated; fallback to other and Owner review is enabled.")
            threshold = max(threshold, 1.01)
        selected = [label for label in LABELS if scores[label] >= threshold]
        confidence = max(scores.values(), default=0.0)
        primary = max(scores, key=scores.get) if scores and confidence >= threshold else "other"
        return IncidentClassification(selected, scores, primary, confidence, not calibrated or not selected, provider, warnings)

    def classify_case(self, case_ctx: dict[str, Any]) -> IncidentClassification | None:
        text = case_text(case_ctx)
        # Callers can keep case text on this server (no hosted inference) with caseCtx.system1AllowHosted=false.
        return self.classify(text, allow_hosted=case_ctx.get("system1AllowHosted", True) is not False) if text.strip() else None

    # ------------------------------------------------------------ 2. agent review
    def review(self, case_ctx: dict[str, Any], results: dict[str, Any], plan: dict[str, Any] | None = None) -> dict[str, Any]:
        """Advisory cross-check of agent outputs against System1's reading of the same snapshot."""
        try:
            routed = self.classify_case(case_ctx)
        except ValueError:
            routed = None
        if routed is None:
            return {"status": "skipped", "reason": "No chunk text in the case snapshot.", "flags": []}
        declared = set(case_ctx.get("incidentLabels") or []) | ({case_ctx["incidentType"]} if case_ctx.get("incidentType") else set())
        flags: list[dict[str, Any]] = []

        def flag(code: str, agent: str | None, message: str) -> None:
            flags.append({"code": code, "agent": agent, "message": message})

        if routed.labels:
            missing = sorted(set(routed.labels) - declared)
            if missing:
                flag("LABELS_NOT_DECLARED", "evidence_gap",
                     f"System1 indicates {', '.join(missing)} but the case snapshot does not; the gap checklist did not evaluate them.")
            extra = sorted(label for label in declared - set(routed.labels) if label in LABELS)
            if extra:
                flag("LABELS_NOT_INDICATED", None, f"Declared {', '.join(extra)} scored below threshold in System1; Owner may review.")
            money = {"financial_fraud", "upi_bank_fraud"} & set(routed.labels)
            fin = results.get("financial_investigation")
            if money and plan is not None and "financial_investigation" not in plan.get("selectedAgents", []):
                flag("FINANCIAL_AGENT_NOT_RUN", "financial_investigation", "Financial labels indicated but the planner did not select the financial agent.")
            if money and isinstance(fin, dict) and not fin.get("error") and not fin.get("ledger") and not ((case_ctx.get("statements") or [])):
                flag("NO_TRANSACTION_RECORDS", "financial_investigation", "Financial labels indicated but no payment events or statements were supplied.")
        gaps = results.get("evidence_gap")
        if isinstance(gaps, dict) and not gaps.get("error") and not gaps.get("evaluatedIncidentTypes"):
            flag("GAP_CHECK_WITHOUT_LABELS", "evidence_gap", "Evidence-gap agent ran with no incident type; use System1 labels once calibrated.")
        failed = sorted(name for name, out in results.items() if isinstance(out, dict) and out.get("error"))
        for name in failed:
            flag("AGENT_FAILED", name, f"{name} returned an error: {results[name]['error'].get('type')}")
        return {"status": "reviewed", "incident": routed.to_json(), "declaredLabels": sorted(declared), "flags": flags,
                "advisory": True, "model": self.model_name}


def _short(exc: Exception) -> str:
    text = str(exc)
    return "HTTP 402: no Inference Provider credits" if "402" in text else f"{type(exc).__name__}: {text[:120]}"


def _hf_post(model: str, text: str) -> Any:
    import httpx

    r = httpx.post(f"https://router.huggingface.co/hf-inference/models/{model}", json={"inputs": text, "parameters": {"question": QUESTIONS}},
                   headers={"Authorization": f"Bearer {os.environ['HF_TOKEN']}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def case_text(case_ctx: dict[str, Any], limit: int = MAX_CHARS) -> str:
    """English working copy of the scoped snapshot, chunk by chunk, up to `limit` characters."""
    parts, size = [], 0
    for chunk in case_ctx.get("chunks", []) or []:
        text = str(chunk.get("textEn") or chunk.get("text") or "").strip()
        if not text:
            continue
        parts.append(text)
        size += len(text) + 1
        if size >= limit:
            break
    return "\n".join(parts)[:limit]


def _hf_answers(result: Any) -> dict[str, dict[str, float]]:
    """Normalize hosted outputs to the per-label positive scores used above."""
    if isinstance(result, dict) and isinstance(result.get("answers"), dict):
        return result["answers"]
    # A single binary result per question; one result alone cannot give four independent labels.
    if isinstance(result, list) and len(result) == len(LABELS):
        answers: dict[str, dict[str, float]] = {}
        for label, prediction in zip(LABELS, result):
            if isinstance(prediction, dict):
                positive = str(prediction.get("label", "")).lower() in {"true", "indicated", label}
                answers[label] = {"noul": prediction.get("score", 0.0) if positive else 0.0}
        return answers
    raise ValueError("Hugging Face response did not contain one score per incident label")


def _positive_probability(answer: dict[str, Any]) -> float:
    value = answer.get("noul")
    if value is not None:
        return max(0.0, min(1.0, float(value)))
    probabilities = answer.get("probabilities", {})
    for key in ("indicated", "true", True):
        if key in probabilities:
            return max(0.0, min(1.0, float(probabilities[key])))
    return 0.0


# Backwards-compatible name from services2 (`app.incident.IncidentRouter`).
IncidentRouter = System1
system1 = System1()
