from __future__ import annotations

import json

import pytest

from runner.audio import PreparedAudio
from runner.models.base import ModelError, parse_feedback_json
from runner.models.openai import OpenAIAdapter
from runner.models.qwen import QwenAdapter


def _chat_response(content: str):
    return (
        200,
        {"content-type": "application/json"},
        json.dumps({"choices": [{"message": {"content": content}}]}).encode(),
    )


class TransportRecorder:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append(
            {"url": url, "headers": dict(headers), "body": json.loads(body), "timeout": timeout}
        )
        return self.response


def _audio():
    return PreparedAudio(
        base64="QUJD",
        data_uri="data:;base64,QUJD",
        format="mp3",
        byte_length=3,
        encoded_length=4,
        duration_seconds=12.0,
        bitrate_kbps=64,
        sha256="0" * 64,
    )


SNAPSHOT = {
    "id": "v2:speak:0:abc",
    "day": 12,
    "stage": "speak",
    "response": "I think this is fine.",
    "context": {"prompt": "Describe a problem."},
    "recordingId": "9b2f6f2e-2a6c-4f1b-8a2d-0f8e5a5a5a5a",
}

TEXT_JSON = json.dumps(
    {"feedback": "改为 I went。", "evidence": "原文 “I go”。", "attempt": "v2:write:0:abc"}
)


def test_text_request_shape_is_dashscope_json_object_without_audio():
    recorder = TransportRecorder(_chat_response(TEXT_JSON))
    adapter = QwenAdapter("sk-test", transport=recorder)
    feedback = adapter.complete_text(
        {"id": "v2:write:0:abc", "day": 12, "stage": "write", "response": "I go."}
    )
    assert feedback.attempt == "v2:write:0:abc"
    call = recorder.calls[0]
    assert call["url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    assert call["body"]["model"] == "qwen3.8-max"
    assert call["body"]["response_format"] == {"type": "json_object"}
    assert call["body"]["reasoning_effort"] == "none"
    assert call["timeout"] == 120.0
    roles = [message["role"] for message in call["body"]["messages"]]
    assert roles == ["system", "user"]
    assert "input_audio" not in json.dumps(call["body"])
    assert call["headers"]["authorization"] == "Bearer sk-test"


AUDIO_JSON = json.dumps(
    {
        "feedback": "注意 /θ/。",
        "evidence": "录音中的 “think” 可以听清。",
        "attempt": SNAPSHOT["id"],
        "pronunciation": {
            "band": 6.5,
            "reviewedWholeClip": True,
            "observation": "The /θ/ was audible but brief.",
        },
    }
)


def test_audio_request_uses_omni_data_uri_and_format():
    recorder = TransportRecorder(_chat_response(AUDIO_JSON))
    adapter = QwenAdapter("sk-test", transport=recorder)
    produced = adapter.complete_audio(SNAPSHOT, _audio())
    assert produced.attempt == SNAPSHOT["id"]
    assert produced.pronunciation is not None and produced.pronunciation.band == 6.5
    call = recorder.calls[0]
    assert call["body"]["model"] == "qwen3.8-omni-flash"
    assert call["timeout"] == 240.0
    content = call["body"]["messages"][1]["content"]
    audio_part = next(part for part in content if part["type"] == "input_audio")
    assert audio_part["input_audio"] == {"data": "data:;base64,QUJD", "format": "mp3"}


def test_feedback_contract_limits():
    from runner.models.base import Feedback

    with pytest.raises(ValueError):
        Feedback(feedback="x" * 6001, evidence="e", attempt="v1:x")
    with pytest.raises(ValueError):
        Feedback(feedback="f", evidence="e" * 2001, attempt="v1:x")
    with pytest.raises(ValueError):
        Feedback(feedback="f", evidence="e", attempt=" ")


def test_invalid_model_json_is_retryable():
    with pytest.raises(ModelError) as caught:
        parse_feedback_json("not json", expect_pronunciation=False)
    assert caught.value.code == "invalid_model_json"
    assert caught.value.retryable is True


def test_grounded_completion_is_plain_text_without_json_object():
    recorder = TransportRecorder(_chat_response("一、评估：只依据已校准韵律。"))
    adapter = QwenAdapter("sk-test", transport=recorder)
    text = adapter.complete_grounded("系统规则", "已校准证据")
    assert text.startswith("一、评估")
    call = recorder.calls[0]
    assert call["body"]["model"] == "qwen3.8-max"
    assert "response_format" not in call["body"]
    assert call["body"]["reasoning_effort"] == "none"
    assert call["timeout"] == 120.0
    assert [m["role"] for m in call["body"]["messages"]] == ["system", "user"]


def test_audio_requires_pronunciation_structure():
    payload = json.dumps(
        {
            "feedback": "ok",
            "evidence": "I think this is fine.",
            "attempt": SNAPSHOT["id"],
        }
    )
    with pytest.raises(ModelError) as caught:
        parse_feedback_json(payload, expect_pronunciation=True)
    assert caught.value.code == "pronunciation_missing"


def test_text_rejects_pronunciation_field():
    payload = json.dumps(
        {
            "feedback": "ok",
            "evidence": "I go.",
            "attempt": "v2:write:0:abc",
            "pronunciation": {
                "band": 6.5,
                "reviewedWholeClip": True,
                "observation": "nice",
            },
        }
    )
    with pytest.raises(ModelError) as caught:
        parse_feedback_json(payload, expect_pronunciation=False)
    assert caught.value.code == "pronunciation_not_allowed"


def test_qwen_requires_api_key():
    with pytest.raises(ModelError) as caught:
        QwenAdapter("")
    assert caught.value.code == "missing_api_key"


def test_openai_stub_refuses_unverified_model_names():
    adapter = OpenAIAdapter("sk-test", transport=TransportRecorder(_chat_response(TEXT_JSON)))
    with pytest.raises(ModelError) as caught:
        adapter.complete_text({"id": "x", "response": "I go."})
    assert caught.value.code == "s2_model_unverified"
    assert caught.value.retryable is False

class SequenceTransport:
    """Return statuses in order; 200 yields a valid plain-text completion."""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0

    def __call__(self, url, headers, body, timeout):
        status = self.statuses[min(self.calls, len(self.statuses) - 1)]
        self.calls += 1
        if status == 200:
            return _chat_response("一、重试成功")
        return status, {"content-type": "application/json"}, b'{"error":"transient"}'


def test_429_backs_off_exponentially_then_succeeds():
    transport = SequenceTransport([429, 429, 200])
    sleeps = []
    adapter = QwenAdapter(
        "sk-test", transport=transport, sleep=sleeps.append, jitter=lambda: 0.0,
        model_max_retries=3,
    )
    assert adapter.complete_grounded("系统规则", "证据") == "一、重试成功"
    assert transport.calls == 3
    assert sleeps == [1.0, 2.0]  # base, then 2x; success stops the backoff


def test_5xx_exhausts_retries_and_raises_retryable_model_error():
    transport = SequenceTransport([503])
    sleeps = []
    adapter = QwenAdapter(
        "sk-test", transport=transport, sleep=sleeps.append, jitter=lambda: 0.0,
        model_max_retries=2,
    )
    with pytest.raises(ModelError) as caught:
        adapter.complete_grounded("系统规则", "证据")
    assert caught.value.code == "model_unavailable"
    assert caught.value.retryable is True
    assert transport.calls == 3  # initial + 2 retries
    assert sleeps == [1.0, 2.0]


def test_circuit_breaker_opens_after_threshold_and_fails_fast():
    transport = SequenceTransport([503])
    sleeps = []
    adapter = QwenAdapter(
        "sk-test", transport=transport, sleep=sleeps.append, jitter=lambda: 0.0,
        model_max_retries=0, circuit_breaker_threshold=2,
        circuit_breaker_cooldown_seconds=60.0,
    )
    for _ in range(2):
        with pytest.raises(ModelError) as caught:
            adapter.complete_grounded("系统规则", "证据")
        assert caught.value.code == "model_unavailable"
    assert transport.calls == 2

    # Open: fail fast without touching the provider (queued tasks requeue).
    with pytest.raises(ModelError) as caught:
        adapter.complete_grounded("系统规则", "证据")
    assert caught.value.code == "model_circuit_open"
    assert caught.value.retryable is True
    assert transport.calls == 2


def test_circuit_breaker_recovers_after_cooldown():
    clock = {"t": 100.0}
    transport = SequenceTransport([503, 200])
    adapter = QwenAdapter(
        "sk-test", transport=transport, sleep=lambda _delay: None,
        jitter=lambda: 0.0, model_max_retries=0,
        circuit_breaker_threshold=1, circuit_breaker_cooldown_seconds=60.0,
        clock=lambda: clock["t"],
    )
    with pytest.raises(ModelError) as caught:
        adapter.complete_grounded("系统规则", "证据")
    assert caught.value.code == "model_unavailable"

    with pytest.raises(ModelError) as caught:
        adapter.complete_grounded("系统规则", "证据")
    assert caught.value.code == "model_circuit_open"
    assert transport.calls == 1

    clock["t"] += 61.0
    assert adapter.complete_grounded("系统规则", "证据") == "一、重试成功"
    assert transport.calls == 2
    assert adapter.circuit_breaker.failures == 0


def test_auth_failure_does_not_retry_or_trip_the_breaker():
    transport = SequenceTransport([401])
    sleeps = []
    adapter = QwenAdapter(
        "sk-test", transport=transport, sleep=sleeps.append, jitter=lambda: 0.0,
        model_max_retries=3, circuit_breaker_threshold=1,
    )
    with pytest.raises(ModelError) as caught:
        adapter.complete_text(
            {"id": "v2:write:0:abc", "day": 12, "stage": "write", "response": "I go."}
        )
    assert caught.value.code == "model_auth_failed"
    assert caught.value.retryable is False
    assert transport.calls == 1 and sleeps == []
    assert adapter.circuit_breaker.is_open is False
