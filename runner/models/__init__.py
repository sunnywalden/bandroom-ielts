"""Model provider factory (S1 qwen, S2 fallback)."""

from __future__ import annotations

from typing import Any

from .base import CoachModel, Feedback, ModelError, Pronunciation, parse_feedback_json
from .openai import OpenAIAdapter
from .qwen import QwenAdapter

__all__ = [
    "CoachModel",
    "Feedback",
    "ModelError",
    "OpenAIAdapter",
    "Pronunciation",
    "QwenAdapter",
    "build_model",
    "parse_feedback_json",
]


def build_model(config: Any) -> CoachModel:
    provider = getattr(config, "provider", "qwen")
    common = {
        "base_url": getattr(config, "model_base_url"),
        "text_model": getattr(config, "text_model"),
        "audio_model": getattr(config, "audio_model"),
        "text_timeout": getattr(config, "text_timeout"),
        "audio_timeout": getattr(config, "audio_timeout"),
    }
    if provider == "qwen":
        return QwenAdapter(getattr(config, "api_key"), **common)
    if provider == "openai":
        return OpenAIAdapter(getattr(config, "api_key"), **common)
    raise ModelError("unknown_provider", f"unknown model provider: {provider}", retryable=False)