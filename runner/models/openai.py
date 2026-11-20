"""S2 fallback adapter (OpenAI-compatible interface, unverified).

The fallback is intentionally a stub-only registration: the model names must
be verified against the provider and owner's data terms before any real call
(design §4.5 / mn-10).  The interface matches :class:`QwenAdapter` so S1 -> S2
is a config switch, not a runner change.

Do not use these placeholder model names in production.
"""

from __future__ import annotations

from typing import Any

from .base import ModelError
from .qwen import QwenAdapter

UNVERIFIED_TEXT_MODEL = "TBD-openai-text-model"
UNVERIFIED_AUDIO_MODEL = "TBD-openai-audio-model"
OPENAI_BASE_URL = "https://api.openai.com/v1"


class OpenAIAdapter(QwenAdapter):
    provider = "openai"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = OPENAI_BASE_URL,
        text_model: str = UNVERIFIED_TEXT_MODEL,
        audio_model: str = UNVERIFIED_AUDIO_MODEL,
        text_timeout: float = 120.0,
        audio_timeout: float = 240.0,
        transport=None,
        model_max_retries: int = 3,
        model_backoff_base_seconds: float = 1.0,
        circuit_breaker_threshold: int = 5,
        circuit_breaker_cooldown_seconds: float = 60.0,
        **options,
    ):
        super().__init__(
            api_key,
            base_url=base_url,
            text_model=text_model,
            audio_model=audio_model,
            text_timeout=text_timeout,
            audio_timeout=audio_timeout,
            transport=transport,
            model_max_retries=model_max_retries,
            model_backoff_base_seconds=model_backoff_base_seconds,
            circuit_breaker_threshold=circuit_breaker_threshold,
            circuit_breaker_cooldown_seconds=circuit_breaker_cooldown_seconds,
            **options,
        )
        self._models_verified = not (
            self.text_model.startswith("TBD-") or self.audio_model.startswith("TBD-")
        )

    def _request_body(
        self, model: str, messages: list[dict[str, Any]], *, json_object: bool = True
    ) -> dict[str, Any]:
        # OpenAI-compatible providers differ on ``reasoning_effort``; do not
        # send provider-specific knobs until the S2 contract is verified.
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
        }
        if json_object:
            body["response_format"] = {"type": "json_object"}
        return body

    def complete_text(self, snapshot):
        if not self._models_verified:
            raise ModelError(
                "s2_model_unverified",
                "S2 model names are placeholders; verify provider and data terms first",
                retryable=False,
            )
        return super().complete_text(snapshot)

    def complete_audio(self, snapshot, audio):
        if not self._models_verified:
            raise ModelError(
                "s2_model_unverified",
                "S2 model names are placeholders; verify provider and data terms first",
                retryable=False,
            )
        return super().complete_audio(snapshot, audio)