"""Model adapter contract shared by Qwen and the S2 fallback."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from ..audio import PreparedAudio
from ..content_rules import Pronunciation


class ModelError(Exception):
    """Classified model/provider failure."""

    def __init__(self, code: str, message: str = "", *, retryable: bool = True):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.retryable = retryable


@dataclass(frozen=True)
class Feedback:
    feedback: str
    evidence: str
    attempt: str
    pronunciation: Pronunciation | None = None

    def __post_init__(self) -> None:
        # Mirror feedbackSpec limits before the value reaches the site.
        for name, maximum in (("feedback", 6000), ("evidence", 2000)):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")
            if len(value.strip()) > maximum:
                raise ValueError(f"{name} exceeds {maximum} characters")
        if not isinstance(self.attempt, str) or not self.attempt.strip():
            raise ValueError("attempt must be the exact reviewAttempts[].id")
        if len(self.attempt.strip()) > 200:
            raise ValueError("attempt exceeds 200 characters")


class CoachModel(Protocol):
    provider: str

    def complete_text(self, snapshot: Mapping[str, Any]) -> Feedback: ...

    def complete_audio(self, snapshot: Mapping[str, Any], audio: PreparedAudio) -> Feedback: ...


def parse_feedback_json(raw: str, *, expect_pronunciation: bool) -> Feedback:
    """Parse the provider's JSON object.

    DashScope's OpenAI-compatible mode supports ``response_format=json_object``
    but not JSON Schema, so this structural check plus
    ``content_rules.validate_feedback`` are the final defence.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ModelError("empty_model_output", "model returned no content", retryable=True)
    text = raw.strip()
    if text.startswith("```"):
        # Some models wrap JSON in a markdown fence despite instructions.
        text = text.strip("`")
        text = text.removeprefix("json").strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ModelError("invalid_model_json", "model output is not JSON", retryable=True) from exc
    if not isinstance(value, dict):
        raise ModelError("invalid_model_json", "model output is not a JSON object", retryable=True)
    feedback = value.get("feedback")
    evidence = value.get("evidence")
    attempt = value.get("attempt")
    if not all(isinstance(item, str) for item in (feedback, evidence, attempt)):
        raise ModelError(
            "invalid_model_structure",
            "model output must contain string feedback, evidence and attempt",
            retryable=True,
        )
    pronunciation_raw = value.get("pronunciation")
    pronunciation: Pronunciation | None = None
    if pronunciation_raw is not None:
        if not isinstance(pronunciation_raw, dict):
            raise ModelError(
                "invalid_model_structure", "pronunciation must be an object", retryable=True
            )
        band = pronunciation_raw.get("band")
        observation = pronunciation_raw.get("observation")
        whole = pronunciation_raw.get("reviewedWholeClip")
        if isinstance(band, bool) or not isinstance(band, (int, float)):
            raise ModelError("invalid_model_structure", "pronunciation.band must be numeric")
        if not isinstance(observation, str) or not isinstance(whole, bool):
            raise ModelError(
                "invalid_model_structure",
                "pronunciation needs observation and reviewedWholeClip",
            )
        pronunciation = Pronunciation(
            band=float(band), observation=observation, reviewed_whole_clip=whole
        )
    if expect_pronunciation and pronunciation is None:
        raise ModelError(
            "pronunciation_missing",
            "audio review must return a structured pronunciation observation",
            retryable=True,
        )
    if not expect_pronunciation and pronunciation is not None:
        raise ModelError(
            "pronunciation_not_allowed",
            "text review must not return pronunciation",
            retryable=True,
        )
    try:
        return Feedback(
            feedback=feedback,
            evidence=evidence,
            attempt=attempt,
            pronunciation=pronunciation,
        )
    except ValueError as exc:
        raise ModelError("invalid_model_structure", str(exc), retryable=True) from exc