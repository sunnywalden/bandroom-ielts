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