"""Structural tier gate, T1 disclosure, timeout, and canonical audio tests.

Covers FIX-4 (tier-aware validator), FIX-5/BL-E (templates, adversarial
T3-as-T2), mn-03 (PHONEME_ASSERTIONS_ENABLED re-render), FIX-7 (reliability),
FIX-18/MJ-08 (Stage B + canonical audio), FIX-20 (no strengths) and FIX-23
(grounded timeout).  No network and no paid model call is made.
"""

from __future__ import annotations

import json
import math
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from runner import contrast_audio, grounded_audio
from runner.content_rules import ContentRuleError
from runner.grounded_audio import (
    GROUNDED_TEXT_TIMEOUT_SECONDS,
    GroundedConfig,
    TierItem,
    classify_candidates,
    compose_grounded_feedback,
    render_portrait,
    render_t3_section,
    review_speaking_grounded,
    validate_grounded_feedback,
)
from runner.orchestrator import ConfigError, RunnerConfig, load_config

RECORDING_ID = "9b2f6f2e-2a6c-4f1b-8a2d-0f8e5a5a5a5a"
RELIABILITY_TEXT = "【T1 可靠性披露】本次停顿检测阈值倍数 1.60（来源：默认）。"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_wav(path: Path, *, seconds: float = 6.0, sample_rate: int = 16000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(seconds * sample_rate)
    t = np.arange(n) / sample_rate
    samples = np.where(
        (t >= 2.0) & (t < 3.0), 0.0, 0.12 * np.sin(2 * math.pi * 220.0 * t)
    )
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return path


def fake_decode(raw, workdir, *, ffmpeg=None):
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    source = workdir / "source.audio"
    source.write_bytes(raw)
    wav = workdir / "decoded-16k.wav"
    make_wav(wav)
    return source, wav


def body_text(*, assessment: str | None = None) -> str:
    first = assessment or "本次只依据已校准的韵律证据评估，未发现可核实的音素错误。"
    return (
        f"一、评估：{first}\n"
        "二、精确引文：你提交的句子是“I think this is fine”。\n"
        "三、建议改写：可以保持原句，无需针对音素错误改写。\n"
        "四、修改原因：\n"
        "1. 在 2.00–2.98 秒处有约 0.98 秒停顿，说明句中断裂。\n"
        "五、下一步：只练一个微练习：把 2.00–2.98 秒的停顿压到 0.5 秒内。\n"
    )


def t2_item(word: str = "this", seconds: float = 20.31) -> dict:
    return {
        "word": word,
        "expected_phone": "DH",
        "actual_phone": "D",
        "timestamp_ms": int(round(seconds * 1000)),
        "provenance": {"source": "personal_calibration", "nConfirmed": 4},
    }


def t3_item(word: str = "office", seconds: float = 3.5) -> dict:
    return {
        "word": word,
        "timestamp_ms": int(round(seconds * 1000)),
        "seconds": seconds,
        "detector_confidence": 0.9,
        "is_error_assertion": False,
    }


def compose(enabled: bool, *, t2=(), t3=(), body: str | None = None):
    assignment = classify_candidates(
        t2, t3, phoneme_assertions_enabled=enabled, max_n=3
    )
    text = compose_grounded_feedback(
        body or body_text(),
        assignment=assignment,
        reliability_text=RELIABILITY_TEXT,
        response="I think this is fine.",
    )
    return assignment, text


def tier_violations(text: str, assignment) -> list[str]:
    return validate_grounded_feedback(
        text,
        response="I think this is fine.",
        t2_items=assignment.t2_items,
        t3_items=assignment.t3_items,
        phoneme_assertions_enabled=assignment.phoneme_assertions_enabled,
        reliability={"pause": "disclosed"},
        require_profile=True,
    )


class FakeGroundedModel:
    provider = "fake"

    def __init__(self, text: str | None = None):
        self.text = text or body_text()
        self.calls: list[dict] = []

    def complete_grounded(self, system, user):
        self.calls.append({"system": system, "user": user})
        return self.text


class TimeoutRecordingModel(FakeGroundedModel):
    def __init__(self, text: str | None = None):
        super().__init__(text)
        self.timeout = None

    def complete_grounded(self, system, user, *, timeout=None):
        self.timeout = timeout
        return super().complete_grounded(system, user)


def grounded_config(tmp: Path, **overrides) -> GroundedConfig:
    values = {
        "acoustic_python": tmp / "missing-python",
        "staging_dir": tmp / "stage",
        "detector_cache_dir": tmp / "cache",
        "self_listen_enabled": False,
        "self_listen_max_n": 3,
    }
    values.update(overrides)
    return GroundedConfig(**values)


def config_obj(tmp: Path, **overrides):
    return SimpleNamespace(grounded=grounded_config(tmp, **overrides))


def run_review(tmp: Path, model, *, attempt=None, config=None):
    attempt = attempt or {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
    }
    return review_speaking_grounded(
        b"raw-audio-bytes",
        attempt,
        12,
        config=config or config_obj(tmp),
        model=model,
        workdir=tmp / "work",
        decode_wav=fake_decode,
    )


# ---------------------------------------------------------------------------
# FIX-4: tier-aware validator, both directions
# ---------------------------------------------------------------------------


def test_t2_assertive_wording_is_accepted_inside_the_t2_block():
    assignment, text = compose(True, t2=[t2_item()], t3=[t3_item()])
    assert "【T2 历史确认】" in text
    assert "读成" in text and "DH→D" in text
    assert tier_violations(text, assignment) == []


def test_t2_assertive_wording_is_rejected_outside_the_t2_block():
    assignment, text = compose(True, t2=[t2_item()], t3=[t3_item()])
    block = grounded_audio.render_t2_block(assignment.t2_items)
    moved = text.replace(block, "").replace(
        "一、评估：", "一、评估：" + block + " "
    )
    violations = tier_violations(moved, assignment)
    assert any(item.startswith("phoneme_assertion") for item in violations), violations
    assert any("t2_word_outside_t2_section" in item for item in violations), violations


def test_t3_assertive_wording_is_rejected():
    assignment, text = compose(False, t3=[t3_item()])
    bad = text.replace(
        "1. 在 3.50 秒处的 office，可对比标准读音自听判断。",
        "1. 在 3.50 秒处的 office，你读错了，应改为 /DH/。",
    )
    violations = tier_violations(bad, assignment)
    assert "self_listen_assertive_phrasing" in violations
    assert any(
        item.startswith("self_listen_word_not_hedged") for item in violations
    ), violations


def test_adversarial_t3_word_phrased_as_t2_claim_is_rejected():
    assignment, _ = compose(True, t2=[t2_item()], t3=[t3_item()])
    adversarial = compose_grounded_feedback(
        body_text(
            assessment="在 3.50 秒处的 office 听起来接近 /d/，值得对比自听。"
        ),
        assignment=assignment,
        reliability_text=RELIABILITY_TEXT,
        response="I think this is fine.",
    )
    violations = tier_violations(adversarial, assignment)
    assert "t3_word_outside_t3_section:office" in violations
    assert "ipa_notation_outside_tier_section" in violations


def test_adversarial_t3_word_phrased_as_a_hedged_claim_without_timestamp():
    assignment, _ = compose(True, t2=[t2_item()], t3=[t3_item()])
    adversarial = compose_grounded_feedback(
        body_text(assessment="你的 office 听起来像 D，可以对比自听。"),
        assignment=assignment,
        reliability_text=RELIABILITY_TEXT,
        response="I think this is fine.",
    )
    violations = tier_violations(adversarial, assignment)
    assert "t3_word_outside_t3_section:office" in violations


def test_adversarial_t3_word_inside_t2_block_is_rejected():
    assignment, text = compose(True, t2=[t2_item()], t3=[t3_item()])
    bad = text.replace(
        "你在 20.31 秒处的 this", "你在 20.31 秒处的 office"
    )
    violations = tier_violations(bad, assignment)
    assert "t2_word_not_allowed:office" in violations
    assert "t2_word_missing:this" in violations


def test_t2_word_moved_into_the_t3_section_is_rejected():
    assignment, text = compose(True, t2=[t2_item()], t3=[t3_item()])
    bad = text.replace(
        "1. 在 3.50 秒处的 office，可对比标准读音自听判断。",
        "1. 在 3.50 秒处的 office，可对比标准读音自听判断。\n"
        "2. 在 20.31 秒处的 this，可对比标准读音自听判断。",
    )
    violations = tier_violations(bad, assignment)
    assert "t2_word_outside_t2_section:this" in violations


def test_no_error_statement_is_qualified_when_t2_is_non_empty():
    assignment, text = compose(True, t2=[t2_item()])
    assert "未发现其他可核实的音素错误" in text
    # The unqualified statement is a violation when a T2 item is present.
    bad = text.replace("未发现其他可核实的音素错误", "未发现可核实的音素错误")
    assert "missing_other_no_error_qualifier" in tier_violations(bad, assignment)


def test_no_error_statement_is_required_when_t2_is_empty():
    assignment, text = compose(False, t3=[t3_item()])
    bad = text.replace("未发现可核实的音素错误", "本次反馈如下")
    assert "missing_no_error_statement" in tier_violations(bad, assignment)


# ---------------------------------------------------------------------------
# FIX-5: deterministic templates + provenance
# ---------------------------------------------------------------------------


def test_templates_are_deterministic_and_order_stable():
    items = [
        TierItem(word="beta", timestamp_ms=3000, seconds=3.0, tier="T3"),
        TierItem(word="alpha", timestamp_ms=1000, seconds=1.0, tier="T3"),
    ]
    first = render_t3_section(items)
    second = render_t3_section(list(reversed(items)))
    assert first == second
    assert render_portrait(
        classify_candidates(None, [], phoneme_assertions_enabled=False)
    ) == render_portrait(
        classify_candidates(None, [], phoneme_assertions_enabled=False)
    )


def test_t2_requires_full_provenance_and_downgrades_otherwise():
    incomplete = [
        {"word": "this", "expected_phone": "DH", "actual_phone": "D", "timestamp_ms": 1000},
        {"word": "that", "actual_phone": "D", "timestamp_ms": 2000, "provenance": "x"},
        {
            "word": "these",
            "expected_phone": "DH",
            "actual_phone": "DH",
            "timestamp_ms": 3000,
            "provenance": "x",
        },
    ]
    assignment = classify_candidates(
        incomplete, [], phoneme_assertions_enabled=True
    )
    assert assignment.t2_items == ()
    # All three still have a word + timestamp, so they are safe T3 suggestions.
    assert {item.word for item in assignment.downgraded} == {"this", "that", "these"}
    assert all(item.downgraded_reason for item in assignment.downgraded)


def test_phoneme_assertions_disabled_rerenders_t2_as_hedged_t3():
    assignment = classify_candidates(
        [t2_item()], [t3_item()], phoneme_assertions_enabled=False, max_n=3
    )
    assert assignment.t2_items == ()
    assert "this" in {item.word for item in assignment.t3_items}
    text = compose_grounded_feedback(
        body_text(),
        assignment=assignment,
        reliability_text=RELIABILITY_TEXT,
    )
    assert "【T2 历史确认】" not in text
    assert "读成" not in text
    assert "未发现可核实的音素错误" in text
    assert "在 20.31 秒处的 this，可对比标准读音自听判断。" in text
    assert tier_violations(text, assignment) == []


def test_phoneme_assertions_enabled_renders_t2_and_no_t3_duplicate():
    assignment = classify_candidates(
        [t2_item()],
        [t3_item(), {"word": "this", "timestamp_ms": 20310}],
        phoneme_assertions_enabled=True,
        max_n=3,
    )
    assert [item.word for item in assignment.t2_items] == ["this"]
    assert [item.word for item in assignment.t3_items] == ["office"]


def test_zero_self_listen_limit_produces_no_items():
    assignment = classify_candidates(
        [t2_item()],
        [t3_item()],
        phoneme_assertions_enabled=True,
        max_n=0,
    )
    assert assignment.t2_items == ()
    assert assignment.t3_items == ()


# ---------------------------------------------------------------------------
# FIX-7 / FIX-20 / FIX-29: disclosure, portrait, no strengths
# ---------------------------------------------------------------------------


def test_t1_reliability_disclosure_is_required_and_macro_caveat_is_honest():
    assignment, text = compose(False, t3=[t3_item()])
    assert "【T1 可靠性披露】" in text
    removed = text.replace(RELIABILITY_TEXT, "")
    assert "missing_reliability_disclosure" in tier_violations(removed, assignment)


def test_portrait_has_no_strengths_block():
    assignment, text = compose(False, t3=[t3_item()])
    portrait = grounded_audio._portrait_section(text)
    assert portrait is not None
    assert "强项" not in portrait
    assert "优势" not in portrait
    injected = text.replace(
        "七、你的发音画像（建议性质）：",
        "七、你的发音画像（建议性质）：\n强项：你的发音很清晰。",
    )
    assert "profile_strengths_claim" in tier_violations(injected, assignment)


# ---------------------------------------------------------------------------
# End-to-end review: deterministic sections, disclosure, timeout
# ---------------------------------------------------------------------------


def test_review_emits_disclosure_and_deterministic_sections(tmp_path):
    model = FakeGroundedModel()
    produced = run_review(tmp_path, model)
    assert "【T1 可靠性披露】" in produced.feedback
    assert "未发现可核实的音素错误" in produced.feedback
    assert "六、建议自听对比（非错误断言）" in produced.feedback
    assert "七、你的发音画像（建议性质）" in produced.feedback
    assert "本次没有可自听对比的建议" in produced.feedback
    assert "强项" not in produced.feedback
    # The model is told it writes only sections 一-五.
    assert "只输出第一至第五部分" in model.calls[0]["user"]


def test_review_rejects_a_t3_word_written_into_t1_prose(tmp_path, monkeypatch):
    monkeypatch.setattr(
        grounded_audio,
        "collect_self_listen_candidates",
        lambda *args, **kwargs: [t3_item("office", 3.5)],
    )
    bad_body = body_text(
        assessment="在 3.50 秒处的 office 听起来接近 /d/。"
    )
    config = config_obj(tmp_path, self_listen_enabled=True)
    with pytest.raises(ContentRuleError) as caught:
        run_review(tmp_path, FakeGroundedModel(bad_body), config=config)
    assert caught.value.code == "grounded_feedback_violation"
    assert "t3_word_outside_t3_section:office" in caught.value.message


def test_t3_is_delivered_when_stage_b_is_enabled(tmp_path, monkeypatch):
    monkeypatch.setattr(
        grounded_audio,
        "collect_self_listen_candidates",
        lambda *args, **kwargs: [t3_item("office", 3.5)],
    )
    model = FakeGroundedModel()  # deliberately omits section 六
    produced = run_review(
        tmp_path, model, config=config_obj(tmp_path, self_listen_enabled=True)
    )
    assert "在 3.50 秒处的 office" in produced.feedback
    # The prompt contains the candidate as evidence.
    assert '"word": "office"' in model.calls[0]["user"]


def test_t3_is_not_invented_when_stage_b_is_disabled(tmp_path):
    produced = run_review(tmp_path, FakeGroundedModel())
    assert "本次没有可自听对比的建议" in produced.feedback
    assert "office" not in produced.feedback


def test_review_passes_the_grounded_timeout(tmp_path):
    model = TimeoutRecordingModel()
    run_review(tmp_path, model)
    assert model.timeout == GROUNDED_TEXT_TIMEOUT_SECONDS == 240.0


def test_review_accepts_a_configured_grounded_timeout(tmp_path):
    model = TimeoutRecordingModel()
    config = SimpleNamespace(
        grounded=grounded_config(tmp_path),
        grounded_text_timeout=300.0,
    )
    run_review(tmp_path, model, config=config)
    assert model.timeout == 300.0


def test_grounded_timeout_config_bounds(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_RUNNER_CLIENT_ID", "id")
    monkeypatch.setenv("TEST_RUNNER_CLIENT_SECRET", "secret")
    monkeypatch.setenv("TEST_DASHSCOPE_KEY", "sk-payg")
    template = """
[site]
client_id_env = "TEST_RUNNER_CLIENT_ID"
client_secret_env = "TEST_RUNNER_CLIENT_SECRET"
[model]
provider = "qwen"
api_key_env = "TEST_DASHSCOPE_KEY"
{model_body}
[grounded]
self_listen_enabled = false
"""
    path = tmp_path / "config.toml"
    path.write_text(template.format(model_body=""), encoding="utf-8")
    assert load_config(path).grounded_text_timeout == 240.0
    path.write_text(
        template.format(model_body="grounded_text_timeout_seconds = 300"),
        encoding="utf-8",
    )
    assert load_config(path).grounded_text_timeout == 300.0
    path.write_text(
        template.format(model_body="grounded_text_timeout_seconds = 120"),
        encoding="utf-8",
    )
    with pytest.raises(ConfigError):
        load_config(path)


def test_runner_config_defaults_and_new_grounded_flags():
    config = RunnerConfig()
    assert config.grounded_text_timeout == 240.0
    assert config.grounded.phoneme_assertions_enabled is False
    assert config.grounded.contrast_audio_enabled is False


# ---------------------------------------------------------------------------
# FIX-18 / MJ-08: canonical contrast audio (fail-closed, no network)
# ---------------------------------------------------------------------------


def test_contrast_audio_disabled_makes_no_call():
    called = []
    result = contrast_audio.synthesize_word(
        "office", enabled=False, transport=lambda *a: called.append(a)
    )
    assert result["status"] == "disabled"
    assert called == []


def test_contrast_audio_uses_native_endpoint_shape(monkeypatch):
    captured = {}

    def transport(body, headers, timeout):
        captured.update(body=body, headers=headers, timeout=timeout)
        return {"output": {"audio": {"url": "https://example.test/a.wav"}}}

    result = contrast_audio.synthesize_word(
        "office", enabled=True, transport=transport, api_key="sk-test"
    )
    assert result["status"] == "ok"
    assert result["url"] == "https://example.test/a.wav"
    assert captured["body"] == {
        "model": "qwen3-tts-flash",
        "input": {"text": "office", "voice": "Cherry"},
    }
    assert captured["headers"]["authorization"] == "Bearer sk-test"
    assert contrast_audio.CONTRAST_TTS_URL.endswith(
        "/multimodal-generation/generation"
    )
    assert "/audio/speech" not in contrast_audio.CONTRAST_TTS_URL


def test_contrast_audio_fails_closed_without_key_or_on_error():
    no_key = contrast_audio.synthesize_word("office", enabled=True)
    assert no_key["status"] == "unavailable"
    assert no_key["reason"] == "missing_api_key"

    def boom(body, headers, timeout):
        raise RuntimeError("network down")

    failed = contrast_audio.synthesize_word(
        "office", enabled=True, transport=boom, api_key="sk-test"
    )
    assert failed["status"] == "unavailable"
    assert failed["reason"] == "tts_error"


def test_contrast_audio_enrichment_is_attached_only_when_enabled():
    candidates = [dict(t3_item("office", 3.5))]
    summary = contrast_audio.enrich_candidates(
        candidates, enabled=False, transport=lambda *a: {}
    )
    assert summary["enabled"] is False
    assert "contrast_audio" not in candidates[0]

    captured = {}

    def transport(body, headers, timeout):
        captured.update(body=body)
        return {"output": {"audio": {"url": "https://example.test/office.wav"}}}

    summary = contrast_audio.enrich_candidates(
        candidates,
        enabled=True,
        transport=transport,
        api_key="sk-test",
        limit=1,
    )
    assert summary["succeeded"] == 1
    assert candidates[0]["contrast_audio"]["status"] == "ok"
    assert captured["body"]["input"]["text"] == "office"


def test_review_contrast_audio_default_off_and_injected_when_enabled(tmp_path):
    # Enabled + injected transport: the canonical URL reaches the prompt evidence.
    model = FakeGroundedModel()

    def transport(body, headers, timeout):
        return {"output": {"audio": {"url": "https://example.test/office.wav"}}}

    config = SimpleNamespace(
        grounded=grounded_config(
            tmp_path, self_listen_enabled=True, contrast_audio_enabled=True
        ),
        contrast_transport=transport,
        api_key="sk-test",
    )

    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(
            grounded_audio,
            "collect_self_listen_candidates",
            lambda *args, **kwargs: [t3_item("office", 3.5)],
        )
        run_review(tmp_path, model, config=config)
    finally:
        monkeypatch.undo()
    assert "https://example.test/office.wav" in model.calls[0]["user"]
    assert '"contrast_audio"' in model.calls[0]["user"]


def test_grounded_config_parses_new_keys():
    parsed = GroundedConfig.from_mapping(
        {
            "phoneme_assertions_enabled": True,
            "contrast_audio_enabled": True,
            "contrast_audio_timeout_seconds": 12,
            "pause_calibration_default_multiplier": 1.4,
        }
    )
    assert parsed.phoneme_assertions_enabled is True
    assert parsed.contrast_audio_enabled is True
    assert parsed.contrast_audio_timeout_seconds == 12.0
    assert parsed.pause_calibration_default_multiplier == 1.4


# ---------------------------------------------------------------------------
# Production-path T2 gate (default off; enable-by-flag)
# ---------------------------------------------------------------------------


def test_review_default_rerenders_t2_candidates_as_hedged_t3(tmp_path, monkeypatch):
    monkeypatch.setattr(
        grounded_audio,
        "collect_self_listen_candidates",
        lambda *args, **kwargs: [],
    )
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
        "t2Candidates": [t2_item()],
    }
    produced = run_review(
        tmp_path,
        FakeGroundedModel(),
        attempt=attempt,
        config=config_obj(tmp_path, self_listen_enabled=True),
    )
    assert "【T2 历史确认】" not in produced.feedback
    assert "读成" not in produced.feedback
    assert "在 20.31 秒处的 this，可对比标准读音自听判断。" in produced.feedback
    assert "未发现可核实的音素错误" in produced.feedback


def test_review_with_assertions_enabled_renders_t2_and_qualifies_no_error(tmp_path):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
        "t2Candidates": [t2_item()],
    }
    produced = run_review(
        tmp_path,
        FakeGroundedModel(),
        attempt=attempt,
        config=config_obj(
            tmp_path, self_listen_enabled=True, phoneme_assertions_enabled=True
        ),
    )
    assert "【T2 历史确认】" in produced.feedback
    assert "读成" in produced.feedback and "DH→D" in produced.feedback
    assert "未发现其他可核实的音素错误" in produced.feedback
    assert "在 20.31 秒处的 this，可对比标准读音自听判断。" not in produced.feedback


def test_grounded_complete_honours_the_explicit_timeout():
    from runner.models.qwen import QwenAdapter

    captured = {}

    def transport(url, headers, body, timeout):
        captured["timeout"] = timeout
        return 200, {}, json.dumps(
            {"choices": [{"message": {"content": "一、评估：ok"}}]}
        ).encode()

    adapter = QwenAdapter("sk-test", transport=transport)
    adapter.complete_grounded("系统", "用户", timeout=240.0)
    assert captured["timeout"] == 240.0