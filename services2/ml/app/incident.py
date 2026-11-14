from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

LABELS = ("harassment", "financial_fraud", "scams", "upi_bank_fraud")
DEFAULT_THRESHOLD = 0.60  # Must be replaced by held-out calibration for deployment.

LABEL_DESCRIPTIONS = {
    "harassment": "Repeated unwanted contact, threats, stalking, abuse, sextortion, or coercion.",
    "financial_fraud": "Deception or impersonation intended to cause financial loss or obtain money.",
    "scams": "Fraudulent offers, phishing, impersonation, or other deceptive schemes, whether or not money moved.",
    "upi_bank_fraud": "Unauthorized UPI, bank-account, card, or payment transaction or credential misuse.",
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


class IncidentRouter:
    """Laya multi-label router over the English working copy.

    When HF_TOKEN is configured, inference runs through Hugging Face's hosted
    Inference API. Without it, the existing local Laya runtime is used.
    """

    def __init__(self) -> None:
        self._agent = None
        self._error: str | None = None
        self._client = None
        self._client_error: str | None = None

    def _load_hf_client(self):
        if self._client is None and self._client_error is None:
            try:
                from huggingface_hub import InferenceClient

                self._client = InferenceClient(
                    provider=os.getenv("HF_PROVIDER", "hf-inference"),
                    api_key=os.environ["HF_TOKEN"],
                )
            except Exception as exc:
                self._client_error = str(exc)
        return self._client

    def _load(self):
        if self._agent is None and self._error is None:
            try:
                from laya import Agent

                model_name = os.getenv("LAYA_MODEL", "convaiinnovations/laya")
                self._agent = Agent(model=model_name)
            except Exception as exc:
                self._error = str(exc)
        return self._agent

    def classify(self, text_en: str, threshold: float | None = None) -> IncidentClassification:
        if not text_en.strip():
            raise ValueError("textEn must contain text")
        warnings: list[str] = []
        threshold = threshold if threshold is not None else float(os.getenv("INCIDENT_CONFIDENCE_THRESHOLD", DEFAULT_THRESHOLD))
        if not 0 <= threshold <= 1:
            raise ValueError("threshold must be in [0, 1]")

        # One binary decision per taxonomy option supports true multi-label
        # assignment, using the same four candidate labels at inference time.
        questions = {
            label: {
                "type": "noul",
                "instructions": f"Does the case evidence indicate {description}",
                "labels": {"false": "not indicated", "true": "indicated"},
            }
            for label, description in LABEL_DESCRIPTIONS.items()
        }
        if os.getenv("HF_TOKEN"):
            client = self._load_hf_client()
            if client is None:
                return IncidentClassification([], {}, "other", 0.0, True, "hf_unavailable", [f"Hugging Face client unavailable: {self._client_error}"])
            try:
                result = client.text_classification(
                    text_en[:12000],
                    model=os.getenv("LAYA_MODEL", "convaiinnovations/laya"),
                    question=questions,
                )
                provider_name = "hf-inference"
            except Exception as exc:
                return IncidentClassification([], {}, "other", 0.0, True, "hf_error", [f"Hugging Face Laya inference failed: {exc}"])
        else:
            agent = self._load()
            if agent is None:
                return IncidentClassification([], {}, "other", 0.0, True, "unavailable", [f"HF_TOKEN is not set; local Laya unavailable: {self._error}"])
            try:
                result = agent.system_one({"text": text_en[:12000]}, questions)
                provider_name = "laya"
        try:
            if provider_name == "hf-inference":
                answers: dict[str, Any] = _hf_answers(result)
            else:
                answers = result.get("answers", {})
            scores = {label: _positive_probability(answers.get(label, {})) for label in LABELS}
            # Do not call raw Laya probabilities calibrated. Calibration is
            # opt-in and only enabled when held-out calibration metadata exists.
            calibrated = os.getenv("LAYA_CALIBRATION_VALIDATED", "false").lower() == "true"
            if not calibrated:
                warnings.append("Laya confidence is uncalibrated; fallback to other and Owner review is enabled.")
            threshold = threshold if calibrated else max(threshold, 1.01)
            selected = [label for label in LABELS if scores[label] >= threshold]
            confidence = max(scores.values(), default=0.0)
            primary = max(scores, key=scores.get) if scores and confidence >= threshold else "other"
            needs_review = not calibrated or not selected
            return IncidentClassification(selected, scores, primary, confidence, needs_review, provider_name, warnings)
        except Exception as exc:
            return IncidentClassification([], {}, "other", 0.0, True, f"{provider_name}_error", [f"Laya classification failed: {exc}"])


def _hf_answers(result: Any) -> dict[str, dict[str, float]]:
    """Normalize hosted outputs to the per-label positive scores used below."""
    if isinstance(result, dict) and isinstance(result.get("answers"), dict):
        return result["answers"]
    # Support providers returning a binary classification result per question.
    # A single result is not enough to infer four independent labels.
    if isinstance(result, list) and len(result) == len(LABELS):
        answers: dict[str, dict[str, float]] = {}
        for label, prediction in zip(LABELS, result):
            if isinstance(prediction, dict):
                answers[label] = {"noul": prediction.get("score", 0.0) if str(prediction.get("label", "")).lower() in {"true", "indicated", label} else 0.0}
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
