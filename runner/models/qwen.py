"""DashScope OpenAI-compatible adapter (S1).

Endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1 (pay-as-you-go
``sk-`` key; never a Coding Plan ``sk-sp-`` key).

* text: qwen3.8-max, text-only (officially no audio input), 120 s timeout.
* audio: qwen3.8-omni-flash, whole mp3 as ``input_audio.data`` data URI plus
  ``format``, 240 s timeout, ``reasoning_effort="none"``.
* ``response_format={"type":"json_object"}`` only: DashScope compatible mode
  does not support JSON Schema, so ``parse_feedback_json`` +
  ``content_rules.validate_feedback`` are the final defence.

No network in tests: ``transport`` is injectable.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping

from ..audio import MAX_DURATION_SECONDS, MAX_ENCODED_BYTES, PreparedAudio
from ..content_rules import system_prompt, user_message
from .base import Feedback, ModelError, parse_feedback_json

DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_TEXT_MODEL = "qwen3.8-max"
DEFAULT_AUDIO_MODEL = "qwen3.8-omni-flash"

ModelTransport = Callable[
    [str, Mapping[str, str], bytes, float], tuple[int, Mapping[str, str], bytes]
]


def urllib_model_transport(
    url: str, headers: Mapping[str, str], body: bytes, timeout: float
) -> tuple[int, Mapping[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ModelError("model_transport_failed", f"model transport failed: {exc}") from exc


class QwenAdapter:
    provider = "qwen"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DASHSCOPE_BASE_URL,
        text_model: str = DEFAULT_TEXT_MODEL,
        audio_model: str = DEFAULT_AUDIO_MODEL,
        text_timeout: float = 120.0,
        audio_timeout: float = 240.0,
        transport: ModelTransport | None = None,
    ):
        if not api_key:
            raise ModelError("missing_api_key", "DashScope API key is not configured", retryable=False)
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.text_model = text_model
        self.audio_model = audio_model
        self.text_timeout = text_timeout
        self.audio_timeout = audio_timeout
        self._transport: ModelTransport = transport or urllib_model_transport
        # Populated by ``_post``; the grounded audio path logs it in the same
        # cost/usage style as the rest of the runner.  Never contains secrets.
        self.last_usage: dict[str, Any] | None = None

    # -- request ----------------------------------------------------------
    def _request_body(
        self, model: str, messages: list[dict[str, Any]], *, json_object: bool = True
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "reasoning_effort": "none",
        }
        if json_object:
            body["response_format"] = {"type": "json_object"}
        return body

    def _post(
        self,
        model: str,
        messages: list[dict[str, Any]],
        timeout: float,
        *,
        json_object: bool = True,
    ) -> str:
        body = json.dumps(
            self._request_body(model, messages, json_object=json_object),
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {
            "content-type": "application/json",
            "accept": "application/json",
            "authorization": f"Bearer {self.api_key}",
        }
        status, _headers, response_body = self._transport(
            f"{self.base_url}/chat/completions", headers, body, timeout
        )
        if status in (401, 403):
            raise ModelError("model_auth_failed", "model provider rejected the API key", retryable=False)
        if status == 429 or status >= 500:
            raise ModelError("model_unavailable", f"model provider returned HTTP {status}")
        if status >= 400:
            raise ModelError(
                "model_request_rejected",
                f"model provider rejected the request (HTTP {status})",
                retryable=False,
            )
        try:
            payload = json.loads(response_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ModelError("model_bad_response", "model response is not JSON", retryable=True) from exc
        usage = payload.get("usage") if isinstance(payload, dict) else None
        self.last_usage = usage if isinstance(usage, dict) else None
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelError(
                "model_bad_response", "model response has no message content", retryable=True
            ) from exc
        if isinstance(content, list):
            # Some compatible endpoints return content parts.
            content = "".join(
                str(part.get("text", "")) for part in content if isinstance(part, dict)
            )
        if not isinstance(content, str):
            raise ModelError("model_bad_response", "model content is not text", retryable=True)
        return content

    # -- CoachModel -------------------------------------------------------
    def complete_text(self, snapshot: Mapping[str, Any]) -> Feedback:
        messages = [
            {"role": "system", "content": system_prompt("text")},
            {"role": "user", "content": user_message(snapshot, track="text")},
        ]
        raw = self._post(self.text_model, messages, self.text_timeout)
        return parse_feedback_json(raw, expect_pronunciation=False)

    def complete_grounded(
        self, system: str, user: str, *, timeout: float | None = None
    ) -> str:
        """Plain-text Chinese feedback grounded in calibrated prosody evidence.

        This path deliberately does not request ``response_format=json_object``:
        the grounded prompt is a six-section Work-format answer, and the runner
        validates the returned prose directly.  It is still a text-only call to
        the same ``qwen3.8-max`` text model used by the text coach.
        """
        if not isinstance(system, str) or not system.strip():
            raise ModelError("invalid_grounded_prompt", "system prompt is empty", retryable=False)
        if not isinstance(user, str) or not user.strip():
            raise ModelError("invalid_grounded_prompt", "user prompt is empty", retryable=False)
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        return self._post(
            self.text_model,
            messages,
            timeout if timeout is not None else self.text_timeout,
            json_object=False,
        )

    def complete_scorecard(
        self, system: str, user: str, *, timeout: float | None = None
    ) -> str:
        """Structured JSON analysis for the speaking scorecard (redesign).

        Separate from complete_grounded: the prose coach forbids JSON/scores,
        while the scorecard call requests strict JSON (grammar/lexical issues
        with verbatim transcript quotes + drills). Same text model; the runner
        validates quotes against the transcript before anything is shown.
        """
        if not isinstance(system, str) or not system.strip():
            raise ModelError("invalid_scorecard_prompt", "system prompt is empty", retryable=False)
        if not isinstance(user, str) or not user.strip():
            raise ModelError("invalid_scorecard_prompt", "user prompt is empty", retryable=False)
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        return self._post(
            self.text_model,
            messages,
            timeout if timeout is not None else self.text_timeout,
            json_object=True,
        )

    def complete_audio(self, snapshot: Mapping[str, Any], audio: PreparedAudio) -> Feedback:
        if not audio.data_uri or not audio.format:
            raise ModelError("invalid_audio_input", "prepared audio is incomplete", retryable=False)
        if audio.encoded_length >= MAX_ENCODED_BYTES:
            raise ModelError(
                "audio_encoded_too_large",
                "encoded audio exceeds the provider limit; refusing to send",
                retryable=False,
            )
        if audio.duration_seconds > MAX_DURATION_SECONDS:
            raise ModelError(
                "audio_too_long",
                "clip exceeds the provider duration limit",
                retryable=False,
            )
        messages = [
            {"role": "system", "content": system_prompt("audio")},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_message(snapshot, track="audio")},
                    {
                        "type": "input_audio",
                        "input_audio": {"data": audio.data_uri, "format": audio.format},
                    },
                ],
            },
        ]
        raw = self._post(self.audio_model, messages, self.audio_timeout)
        return parse_feedback_json(raw, expect_pronunciation=True)