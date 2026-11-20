from __future__ import annotations

import hashlib
import json
import math
import subprocess
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from runner import grounded_audio
from runner.content_rules import (
    ContentRuleError,
    Pronunciation,
    feedback_to_tool_args,
    validate_feedback,
)
from runner.grounded_audio import (
    DETECTOR_MAX_SECONDS,
    DETECTOR_MIN_SECONDS,
    GroundedConfig,
    analyze_calibrated,
    assert_detector_script_sha,
    build_evidence_document,
    build_prompt,
    candidates_from_payload,
    collect_self_listen_candidates,
    count_micro_drills,
    detector_cache_path,
    review_speaking_grounded,
    validate_grounded_feedback,
)
from runner.models import Feedback
from runner.orchestrator import (
    CoachRunner,
    ConfigError,
    RunnerConfig,
    load_config,
    resolve_coach_audio_mode,
)

RECORDING_ID = "9b2f6f2e-2a6c-4f1b-8a2d-0f8e5a5a5a5a"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_wav(path: Path, *, seconds: float = 6.0, sample_rate: int = 16000) -> Path:
    """PCM16 mono WAV with tones and a clear ~1 s pause at 2.0-3.0 s."""
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


def valid_feedback_text(*, candidate_lines: str | None = None) -> str:
    section_six = candidate_lines or "本次没有可自听对比的建议。"
    return (
        "一、评估：本次只依据已校准的韵律证据评估，未发现可核实的音素错误。\n"
        "二、精确引文：你提交的句子是“I think this is fine”。\n"
        "三、建议改写：可以保持原句，无需针对音素错误改写。\n"
        "四、修改原因：\n"
        "1. 在 2.00–2.98 秒处有约 0.98 秒停顿，说明句中断裂。\n"
        "五、下一步：只练一个微练习：把 2.00–2.98 秒的停顿压到 0.5 秒内。\n"
        "六、建议自听对比（非错误断言）：\n"
        f"{section_six}"
    )


def candidate(word: str, seconds: float) -> dict:
    return {
        "word": word,
        "timestamp_ms": int(round(seconds * 1000)),
        "seconds": seconds,
        "detector_confidence": 0.9,
        "is_error_assertion": False,
    }


class FakeGroundedModel:
    provider = "fake"

    def __init__(self, text: str | None = None, *, usage=None):
        self.text = text or valid_feedback_text()
        self.last_usage = usage or {"total_tokens": 321, "prompt_tokens": 200}
        self.calls: list[tuple[str, str]] = []

    def complete_grounded(self, system, user):
        self.calls.append((system, user))
        return self.text


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


def grounded_config_obj(tmp: Path, **overrides):
    return SimpleNamespace(grounded=grounded_config(tmp, **overrides))


# ---------------------------------------------------------------------------
# Config precedence
# ---------------------------------------------------------------------------


CONFIG_TEMPLATE = """
[site]
base_url = "https://bandroom.example.test"
client_id_env = "TEST_RUNNER_CLIENT_ID"
client_secret_env = "TEST_RUNNER_CLIENT_SECRET"

[model]
provider = "qwen"
api_key_env = "TEST_DASHSCOPE_KEY"

[runner]
{runner}

[budget]
daily_cap_cny = 3.5
text_cost_cny = 0.01
audio_cost_cny = 0.2
grounded_cost_cny = 0.12

[grounded]
self_listen_enabled = false
self_listen_max_n = 3
"""


def write_config(tmp_path, runner_body: str) -> Path:
    path = tmp_path / "config.toml"
    path.write_text(CONFIG_TEMPLATE.format(runner=runner_body), encoding="utf-8")
    return path


def set_secrets(monkeypatch):
    monkeypatch.setenv("TEST_RUNNER_CLIENT_ID", "client-id")
    monkeypatch.setenv("TEST_RUNNER_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("TEST_DASHSCOPE_KEY", "sk-payg")


def test_mode_resolution_preserves_legacy_boolean(tmp_path, monkeypatch):
    set_secrets(monkeypatch)
    # No mode + coach_audio=false: production today -> off.
    path = write_config(tmp_path, 'coach_audio = false')
    config = load_config(path)
    assert config.coach_audio_mode is None
    assert resolve_coach_audio_mode(config) == "off"

    # No mode + coach_audio=true: pre-existing config -> legacy, exactly as before.
    path = write_config(tmp_path, 'coach_audio = true')
    config = load_config(path)
    assert resolve_coach_audio_mode(config) == "legacy"

    # Explicit mode wins over the boolean.
    path = write_config(tmp_path, 'coach_audio = true\ncoach_audio_mode = "off"')
    assert resolve_coach_audio_mode(load_config(path)) == "off"

    path = write_config(tmp_path, 'coach_audio = false\ncoach_audio_mode = "grounded"')
    assert resolve_coach_audio_mode(load_config(path)) == "grounded"


def test_direct_runner_config_default_keeps_legacy_behaviour():
    config = RunnerConfig()
    assert config.coach_audio is True
    assert config.coach_audio_mode is None
    assert resolve_coach_audio_mode(config) == "legacy"
    assert resolve_coach_audio_mode(RunnerConfig(coach_audio=False)) == "off"


def test_invalid_mode_is_rejected(tmp_path, monkeypatch):
    set_secrets(monkeypatch)
    path = write_config(tmp_path, 'coach_audio_mode = "loud"')
    with pytest.raises(ConfigError):
        load_config(path)
    with pytest.raises(ConfigError):
        resolve_coach_audio_mode(RunnerConfig(coach_audio_mode="loud"))


def test_grounded_config_is_parsed_without_secrets(tmp_path, monkeypatch):
    set_secrets(monkeypatch)
    path = write_config(
        tmp_path,
        'coach_audio_mode = "grounded"\ncoach_audio = false',
    )
    config = load_config(path)
    assert config.grounded_cost_cny == 0.12
    assert config.grounded.self_listen_enabled is False
    assert "sk-payg" not in path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Stage A: calibrated-only evidence
# ---------------------------------------------------------------------------


def test_calibrated_evidence_surfaces_pauses_not_pitch(tmp_path):
    wav = make_wav(tmp_path / "six.wav")
    analysis = analyze_calibrated(wav)
    calibrated = analysis["calibrated"]
    for key in (
        "total_duration_seconds",
        "speech_span",
        "speech_duration_seconds",
        "speech_ratio",
        "pause_count",
        "pause_seconds",
        "pauses",
    ):
        assert key in calibrated
    assert calibrated["pause_count"] >= 1
    assert calibrated["pauses"][0]["seconds"] > 0.3

    document = build_evidence_document(analysis)
    payload = json.dumps(document, ensure_ascii=False)
    for forbidden in (
        "median_hz",
        "p10_hz",
        "p90_hz",
        "range_semitones",
        "f0_frames",
        "words_per_minute",
        "articulation_rate_wps",
        "filler_count",
    ):
        assert forbidden not in payload
        assert forbidden not in document["calibrated_prosody"]


def test_vendored_prosody_rejects_uncalibrated_measurement_use():
    from runner import prosody

    envelope = prosody.metric(
        220.0, prosody.STATUS_CONSISTENCY, caveat="pitch is not ground truth"
    )
    with pytest.raises(prosody.UncalibratedMetricError):
        prosody.require_measurement(envelope)


def test_prompt_forbids_phoneme_assertions_and_uncalibrated_numbers(tmp_path):
    wav = make_wav(tmp_path / "six.wav")
    analysis = analyze_calibrated(wav)
    attempt = {
        "id": "v2:speak:0:abc",
        "response": "I think this is fine.",
        "recordingId": RECORDING_ID,
    }
    system, user = build_prompt(attempt, analysis, day=12)
    assert "禁止断言任何音素/发音错误" in system
    assert "未发现可核实的音素错误" in system
    assert "恰好一个微练习" in system
    assert "禁止声称测过音高" in system
    assert "median_hz" not in user
    assert "words_per_minute" not in user
    assert "6.0" in user  # calibrated total duration is evidence
    assert "自听建议" in (system + user)


# ---------------------------------------------------------------------------
# Validator: phoneme assertions and uncalibrated claims
# ---------------------------------------------------------------------------


def test_valid_grounded_feedback_passes():
    assert validate_grounded_feedback(
        valid_feedback_text(), response="I think this is fine."
    ) == []
    assert count_micro_drills(valid_feedback_text()) == 1


def test_assertive_phoneme_claim_is_rejected():
    text = valid_feedback_text().replace(
        "未发现可核实的音素错误", "你读错了 his，发音错误"
    )
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert any("phoneme_assertion" in item for item in violations), violations


def test_phone_pair_assertion_is_rejected():
    text = valid_feedback_text() + "\n补充：his 的 Z→S 需要纠正。"
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert "phoneme_assertion:phone_pair" in violations or any(
        "phoneme_assertion" in item for item in violations
    )


def test_pitch_and_wpm_numbers_are_rejected():
    base = valid_feedback_text()
    claim = "补充：你的音高约 220 Hz，语速 120 WPM。\n"
    text = base.replace("六、建议自听对比", claim + "六、建议自听对比")
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert "uncalibrated_metric_claim:pitch" in violations
    assert "uncalibrated_metric_claim:rate_or_filler" in violations

    negated = base.replace(
        "六、建议自听对比",
        "补充：本次未测音高，也没有测 WPM。\n六、建议自听对比",
    )
    assert validate_grounded_feedback(
        negated, response="I think this is fine."
    ) == []


def test_micro_drill_count_is_enforced():
    text = valid_feedback_text() + "\n六、下一步：再练第二个微练习。\n"
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert any("micro_drill_count:2" in item for item in violations), violations


def test_overall_speaking_band_is_rejected():
    text = valid_feedback_text().replace(
        "一、评估：", "一、评估：口语总分 6.5，"
    )
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert "overall_speaking_band_claim" in violations


def test_pronunciation_score_number_is_rejected():
    text = valid_feedback_text().replace(
        "一、评估：", "一、评估：发音 6.5，"
    )
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert "pronunciation_score_claim" in violations


# ---------------------------------------------------------------------------
# Self-listening section validator
# ---------------------------------------------------------------------------


def _candidate_section(*pairs: tuple[str, float]) -> str:
    return "\n".join(
        f"{index}. 在 {seconds:.2f} 秒处的 {word}，可对比标准读音自听判断。"
        for index, (word, seconds) in enumerate(pairs, 1)
    )


def test_self_listen_section_accepts_only_candidates():
    candidates = [candidate("his", 1.25), candidate("office", 3.5)]
    text = valid_feedback_text(
        candidate_lines=_candidate_section(("his", 1.25), ("office", 3.5))
    )
    assert validate_grounded_feedback(
        text, response="I think this is fine.", self_listen=candidates
    ) == []


def test_self_listen_rejects_non_hedged_word():
    candidates = [candidate("his", 1.25)]
    text = valid_feedback_text(
        candidate_lines=_candidate_section(("business", 1.25))
    )
    violations = validate_grounded_feedback(
        text, response="I think this is fine.", self_listen=candidates
    )
    assert "self_listen_word_not_hedged:business" in violations


def test_self_listen_rejects_assertive_phrasing():
    candidates = [candidate("his", 1.25)]
    text = valid_feedback_text(
        candidate_lines=(
            "1. 在 1.25 秒处的 his，你读错了，可对比标准读音自听判断。"
        )
    )
    violations = validate_grounded_feedback(
        text, response="I think this is fine.", self_listen=candidates
    )
    assert "self_listen_assertive_phrasing" in violations


def test_self_listen_enforces_max_n():
    candidates = [candidate(word, index + 1.0) for index, word in enumerate(
        ("his", "office", "the", "other")
    )]
    text = valid_feedback_text(
        candidate_lines=_candidate_section(
            ("his", 1.0), ("office", 2.0), ("the", 3.0), ("other", 4.0)
        )
    )
    violations = validate_grounded_feedback(
        text,
        response="I think this is fine.",
        self_listen=candidates,
        max_self_listen=3,
    )
    assert "self_listen_too_many:4" in violations


def test_self_listen_requires_a_timestamp_near_the_word():
    candidates = [candidate("his", 1.25)]
    text = valid_feedback_text(
        candidate_lines="1. 在 his 附近，可对比标准读音自听判断。"
    )
    violations = validate_grounded_feedback(
        text, response="I think this is fine.", self_listen=candidates
    )
    assert "self_listen_missing_timestamp:his" in violations


def test_self_listen_cannot_invent_words_without_candidates():
    text = valid_feedback_text(candidate_lines="1. 在 1.25 秒处的 his。")
    violations = validate_grounded_feedback(text, response="I think this is fine.")
    assert "self_listen_word_not_hedged:his" in violations


# ---------------------------------------------------------------------------
# End-to-end Stage A review + pronunciation contract
# ---------------------------------------------------------------------------


def test_review_speaking_grounded_omits_pronunciation_rating(tmp_path):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
        "context": {"prompt": "Describe a problem."},
    }
    config = grounded_config_obj(tmp_path)
    model = FakeGroundedModel()
    produced = review_speaking_grounded(
        b"raw-audio-bytes",
        attempt,
        12,
        config=config,
        model=model,
        workdir=tmp_path / "work",
        decode_wav=fake_decode,
    )

    assert produced.attempt == attempt["id"]
    # No pronunciation rating is emitted.  The MCP feedbackSpec marks it
    # .optional() and prescribes absence for technical decoding; lib/coach.ts
    # would otherwise render any numeric band to the learner as "发音专项暂定 X/9".
    assert produced.pronunciation is None
    # The honest "no verified phoneme error" statement lives in the feedback text.
    assert "未发现可核实的音素错误" in produced.feedback

    # Reuses exactly the existing writeback path.
    validated = validate_feedback(
        produced.feedback,
        produced.evidence,
        produced.attempt,
        expected_attempt=attempt["id"],
        stage="speak",
        recording_id=RECORDING_ID,
        pronunciation=produced.pronunciation,
        audio_used=True,
        response=attempt["response"],
    )
    arguments = feedback_to_tool_args(
        validated, day=12, stage="speak", recording_id=RECORDING_ID, audio_used=True
    )
    # The writeback must not carry a pronunciation key at all, so the server
    # stores rating = null and no band string is rendered.
    assert "pronunciation" not in arguments
    assert arguments["recordingId"] == RECORDING_ID

    # The model saw calibrated evidence only.
    prompt = model.calls[0][1]
    assert "median_hz" not in prompt
    assert "words_per_minute" not in prompt
    assert "calibrated_prosody" in prompt


def test_review_rejects_model_output_that_asserts_a_phoneme_error(tmp_path):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
    }
    bad = valid_feedback_text().replace(
        "未发现可核实的音素错误", "你读错了 his，发音错误"
    )
    with pytest.raises(ContentRuleError) as caught:
        review_speaking_grounded(
            b"raw",
            attempt,
            12,
            config=grounded_config_obj(tmp_path),
            model=FakeGroundedModel(bad),
            workdir=tmp_path / "work",
            decode_wav=fake_decode,
        )
    assert caught.value.code == "grounded_feedback_violation"
    assert caught.value.retryable is True


def test_stage_b_failure_falls_closed_to_stage_a(tmp_path):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
    }
    # self_listen_enabled, but the acoustic venv path is missing.
    config = grounded_config_obj(tmp_path, self_listen_enabled=True)
    model = FakeGroundedModel()
    produced = review_speaking_grounded(
        b"raw",
        attempt,
        12,
        config=config,
        model=model,
        workdir=tmp_path / "work",
        decode_wav=fake_decode,
    )
    assert produced.pronunciation is None
    assert model.calls  # Stage A still ran
    assert "self_listen_suggestions\": []" in model.calls[0][1]


def test_stage_b_candidates_reach_the_self_listen_section(tmp_path, monkeypatch):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
    }
    candidates = [candidate("his", 1.25), candidate("office", 3.5)]
    monkeypatch.setattr(
        grounded_audio,
        "collect_self_listen_candidates",
        lambda *args, **kwargs: candidates,
    )
    config = grounded_config_obj(tmp_path, self_listen_enabled=True)
    model = FakeGroundedModel(
        valid_feedback_text(
            candidate_lines=_candidate_section(("his", 1.25), ("office", 3.5))
        )
    )
    produced = review_speaking_grounded(
        b"raw",
        attempt,
        12,
        config=config,
        model=model,
        workdir=tmp_path / "work",
        decode_wav=fake_decode,
    )
    prompt = model.calls[0][1]
    assert '"word": "his"' in prompt
    assert '"word": "office"' in prompt
    assert "六、建议自听对比（非错误断言）" in produced.feedback
    assert produced.pronunciation is None


def test_review_rejects_output_longer_than_the_configured_limit(tmp_path):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
    }
    config = SimpleNamespace(
        grounded=grounded_config(tmp_path), max_duration_seconds=1.0
    )
    with pytest.raises(grounded_audio.AudioError) as caught:
        review_speaking_grounded(
            b"raw",
            attempt,
            12,
            config=config,
            model=FakeGroundedModel(),
            workdir=tmp_path / "work",
            decode_wav=fake_decode,
        )
    assert caught.value.code == "audio_too_long"


# ---------------------------------------------------------------------------
# Stage B: frozen detector, fail-closed
# ---------------------------------------------------------------------------


def _stage_assets(tmp_path: Path, *, script_text: str = "detector") -> tuple[GroundedConfig, Path]:
    stage = tmp_path / "stage"
    stage.mkdir(parents=True, exist_ok=True)
    script = stage / "frozen-inference.py"
    script.write_text(script_text, encoding="utf-8")
    (stage / "crottc").mkdir()
    ffmpeg = stage / "rescued" / "ffmpeg-pin" / "ffmpeg"
    ffmpeg.parent.mkdir(parents=True)
    ffmpeg.write_text("ffmpeg", encoding="utf-8")
    python = stage / "env" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    whisper = tmp_path / "whisper.pt"
    whisper.write_text("whisper", encoding="utf-8")
    config = GroundedConfig(
        acoustic_python=python,
        staging_dir=stage,
        detector_whisper=whisper,
        detector_cache_dir=tmp_path / "cache",
        self_listen_enabled=True,
        self_listen_max_n=3,
        detector_timeout_seconds=5,
    )
    return config, script


def test_detector_sha_assertion_rejects_mismatch(tmp_path):
    _, script = _stage_assets(tmp_path, script_text="not the frozen detector")
    with pytest.raises(grounded_audio.DetectorUnavailable) as caught:
        assert_detector_script_sha(script)
    assert caught.value.code == "detector_sha_mismatch"


def test_detector_sha_assertion_accepts_the_frozen_sha(tmp_path, monkeypatch):
    _, script = _stage_assets(tmp_path, script_text="frozen bytes")
    sha = hashlib.sha256(script.read_bytes()).hexdigest()
    monkeypatch.setattr(grounded_audio, "FROZEN_DETECTOR_SHA256", sha)
    assert assert_detector_script_sha(script) == sha


def test_stage_b_missing_venv_fails_closed(tmp_path):
    config = grounded_config(tmp_path, self_listen_enabled=True)
    # Staging dir exists but the venv python does not.
    assert collect_self_listen_candidates(
        "a" * 64, tmp_path / "source.audio", grounded=config, duration_seconds=6.0
    ) == []


def test_stage_b_bad_sha_fails_closed(tmp_path):
    config, _ = _stage_assets(tmp_path)
    assert collect_self_listen_candidates(
        "a" * 64, tmp_path / "source.audio", grounded=config, duration_seconds=6.0
    ) == []


def test_stage_b_out_of_range_duration_skips_inference(tmp_path):
    config, _ = _stage_assets(tmp_path)
    called = []

    def run(*args, **kwargs):
        called.append(args)
        raise AssertionError("detector must not run out of range")

    for duration in (DETECTOR_MIN_SECONDS - 0.1, DETECTOR_MAX_SECONDS + 0.1):
        assert collect_self_listen_candidates(
            "a" * 64,
            tmp_path / "source.audio",
            grounded=config,
            duration_seconds=duration,
            run=run,
        ) == []
    assert called == []


def test_stage_b_timeout_fails_closed(tmp_path, monkeypatch):
    config, script = _stage_assets(tmp_path)
    monkeypatch.setattr(
        grounded_audio,
        "FROZEN_DETECTOR_SHA256",
        hashlib.sha256(script.read_bytes()).hexdigest(),
    )

    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=1)

    assert collect_self_listen_candidates(
        "b" * 64,
        tmp_path / "source.audio",
        grounded=config,
        duration_seconds=6.0,
        run=run,
    ) == []


def test_stage_b_nonzero_exit_fails_closed(tmp_path, monkeypatch):
    config, script = _stage_assets(tmp_path)
    monkeypatch.setattr(
        grounded_audio,
        "FROZEN_DETECTOR_SHA256",
        hashlib.sha256(script.read_bytes()).hexdigest(),
    )

    def run(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="boom")

    assert collect_self_listen_candidates(
        "c" * 64,
        tmp_path / "source.audio",
        grounded=config,
        duration_seconds=6.0,
        run=run,
    ) == []


def test_stage_b_cache_hit_does_not_rerun_inference(tmp_path, monkeypatch):
    config, script = _stage_assets(tmp_path)
    sha = hashlib.sha256(script.read_bytes()).hexdigest()
    monkeypatch.setattr(grounded_audio, "FROZEN_DETECTOR_SHA256", sha)
    audio_sha = "d" * 64
    payload = {
        "sourceSha256": audio_sha,
        "detectorScriptSha256": sha,
        "predictions": [
            {"word": "his", "time": 1.25, "confidence": 0.95},
            {"word": "office", "time": 3.5, "confidence": 0.72},
        ],
    }
    cache = detector_cache_path(audio_sha, config.detector_cache_dir)
    cache.parent.mkdir(parents=True)
    cache.write_text(json.dumps(payload), encoding="utf-8")

    def run(*args, **kwargs):
        raise AssertionError("cache hit must not run inference")

    result = collect_self_listen_candidates(
        audio_sha,
        tmp_path / "source.audio",
        grounded=config,
        duration_seconds=6.0,
        run=run,
    )
    assert [item["word"] for item in result] == ["his", "office"]
    assert all(item["is_error_assertion"] is False for item in result)


def test_candidates_are_capped_and_neutral():
    payload = {
        "predictions": [
            {"word": word, "time": index + 1.0, "confidence": 0.9 - index * 0.01}
            for index, word in enumerate(("a", "b", "c", "d", "e"))
        ]
    }
    result = candidates_from_payload(payload, max_n=3)
    assert len(result) == 3
    assert all(item["is_error_assertion"] is False for item in result)
    assert all("可对比标准读音自听判断" in item["suggestion_zh"] for item in result)
    assert all("读错" not in item["suggestion_zh"] for item in result)
    assert candidates_from_payload(payload, max_n=0) == []


# ---------------------------------------------------------------------------
# Orchestrator dispatch + cost
# ---------------------------------------------------------------------------


class FakeClient:
    def __init__(self, session, *, recording=b"fake-audio-bytes"):
        self.session = session
        self.recording = recording
        self.calls = []
        self.recording_calls = 0

    def call_tool(self, name, arguments=None, *, client_run_id=None):
        arguments = dict(arguments or {})
        self.calls.append((name, arguments, client_run_id))
        if name == "report_scheduler_heartbeat":
            return {"ok": True}
        if name == "read_study_session":
            return json.loads(json.dumps(self.session))
        if name == "read_speaking_recording":
            self.recording_calls += 1
            return {
                "size": len(self.recording),
                "length": len(self.recording),
                "offset": 0,
                "nextOffset": None,
                "base64": __import__("base64").b64encode(self.recording).decode(),
                "sha256": hashlib.sha256(self.recording).hexdigest(),
            }
        if name == "add_coach_feedback":
            return {"saved": True, "duplicate": False, "receiptId": "receipt-1"}
        raise AssertionError(f"unexpected tool: {name}")

    def feedback_calls(self):
        return [args for name, args, _ in self.calls if name == "add_coach_feedback"]


class FakeTextModel:
    provider = "fake"
    last_usage = None

    def complete_text(self, snapshot):
        return Feedback(
            feedback="把 “I go” 改成 “I went”，因为 yesterday 是过去时间。",
            evidence=f"原文写的是 “{snapshot['response']}”。",
            attempt=str(snapshot["id"]),
        )


def speaking_attempt():
    return {
        "id": "v2:speak:0:abc",
        "day": 12,
        "stage": "speak",
        "kind": "subjective",
        "status": "awaiting_coach",
        "title": "口语 Part 2",
        "response": "I think this is fine.",
        "conditions": "已提交录音",
        "recordingId": RECORDING_ID,
        "recordingSha256": hashlib.sha256(b"fake-audio-bytes").hexdigest(),
        "context": {"prompt": "Describe a problem."},
    }


def text_attempt():
    return {
        "id": "v2:write:0:abc",
        "day": 12,
        "stage": "write",
        "kind": "subjective",
        "status": "awaiting_coach",
        "title": "写作首稿",
        "response": "I go to school yesterday.",
        "conditions": "限时 20 分钟",
        "context": {"prompt": "Describe your day."},
    }


def runner_config(tmp_path, **overrides):
    values = {
        "state_dir": tmp_path / "state",
        "client_id": "client-id",
        "client_secret": "client-secret",
        "api_key": "sk-test",
        "daily_cap_cny": 20.0,
        "coach_audio": True,
        "coach_audio_mode": None,
        "grounded": grounded_config(tmp_path),
        "grounded_cost_cny": 0.12,
    }
    values.update(overrides)
    return RunnerConfig(**values)


def test_off_mode_skips_speaking_and_still_reviews_text(tmp_path):
    session = {"day": 12, "reviewAttempts": [speaking_attempt(), text_attempt()]}
    client = FakeClient(session)
    coach = CoachRunner(
        runner_config(tmp_path, coach_audio_mode="off"),
        client=client,
        model=FakeTextModel(),
    )
    report = coach.run()
    assert report.processed == 1
    assert client.recording_calls == 0
    assert [call["attempt"] for call in client.feedback_calls()] == ["v2:write:0:abc"]


def test_legacy_boolean_false_still_skips_speaking_without_a_mode(tmp_path):
    """An existing config with coach_audio=false must behave exactly as today."""
    session = {"day": 12, "reviewAttempts": [speaking_attempt(), text_attempt()]}
    client = FakeClient(session)
    coach = CoachRunner(
        runner_config(tmp_path, coach_audio=False, coach_audio_mode=None),
        client=client,
        model=FakeTextModel(),
    )
    report = coach.run()
    assert report.processed == 1
    assert client.recording_calls == 0
    assert [call["attempt"] for call in client.feedback_calls()] == ["v2:write:0:abc"]


class FakeAudioModel:
    provider = "fake"

    def complete_audio(self, snapshot, audio):
        return Feedback(
            feedback="注意 think 的 /θ/，下一次放慢一点。",
            evidence=f"录音 {snapshot.get('recordingId')} 中的 “think” 可以听清。",
            attempt=str(snapshot["id"]),
            pronunciation=Pronunciation(band=6.5, observation="The /θ/ was audible."),
        )


def test_legacy_boolean_true_still_uses_the_old_audio_path(tmp_path):
    """An existing config with coach_audio=true must keep the legacy path."""
    session = {"day": 12, "reviewAttempts": [speaking_attempt()]}
    client = FakeClient(session)
    prepared = []

    def prepare(raw, *, workdir, bitrates_kbps):
        from runner.audio import PreparedAudio

        prepared.append(raw)
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

    coach = CoachRunner(
        runner_config(tmp_path, coach_audio=True, coach_audio_mode=None),
        client=client,
        model=FakeAudioModel(),
        prepare_audio=prepare,
    )
    report = coach.run()
    assert report.processed == 1
    assert prepared == [b"fake-audio-bytes"]
    assert client.feedback_calls()[0]["pronunciation"]["band"] == 6.5


def test_grounded_mode_processes_speak_and_reserves_cost(tmp_path, monkeypatch):
    session = {"day": 12, "reviewAttempts": [speaking_attempt()]}
    client = FakeClient(session)
    captured = {}

    def fake_review(raw, attempt, day, *, config, model, workdir, logger=None,
                    tenant_user_id=None):
        captured.update(raw=raw, attempt=attempt, day=day, config=config,
                        tenant_user_id=tenant_user_id)
        return Feedback(
            feedback=valid_feedback_text(),
            evidence=f"录音 {RECORDING_ID}；已校准韵律证据：停顿 1 个。",
            attempt=attempt["id"],
            pronunciation=None,
        )

    monkeypatch.setattr(
        grounded_audio, "review_speaking_grounded", fake_review
    )
    prep_calls = []
    coach = CoachRunner(
        runner_config(tmp_path, coach_audio_mode="grounded"),
        client=client,
        model=FakeTextModel(),
        prepare_audio=lambda *a, **k: prep_calls.append((a, k)),
    )
    report = coach.run()

    assert report.processed == 1
    assert client.recording_calls == 1
    assert captured["raw"] == b"fake-audio-bytes"
    assert prep_calls == []  # the legacy mp3 transcode path is not used
    feedback = client.feedback_calls()[0]
    assert feedback["stage"] == "speak"
    assert feedback["recordingId"] == RECORDING_ID
    assert "pronunciation" not in feedback
    assert coach.state.data["cost"]["spentCny"] == pytest.approx(0.12)


def test_grounded_mode_default_does_not_run_legacy_audio_model(tmp_path):
    """With mode grounded, complete_audio must never be called."""
    session = {"day": 12, "reviewAttempts": [speaking_attempt()]}
    client = FakeClient(session)

    class ModelThatWouldFailOnAudio(FakeTextModel):
        def complete_audio(self, snapshot, audio):
            raise AssertionError("legacy audio model must not be used")

    monkeypatch_grounded = pytest.MonkeyPatch()
    try:
        monkeypatch_grounded.setattr(
            grounded_audio,
            "review_speaking_grounded",
            lambda *a, **k: Feedback(
                feedback=valid_feedback_text(),
                evidence=f"录音 {RECORDING_ID}；已校准韵律证据。",
                attempt="v2:speak:0:abc",
                pronunciation=None,
            ),
        )
        coach = CoachRunner(
            runner_config(tmp_path, coach_audio_mode="grounded"),
            client=client,
            model=ModelThatWouldFailOnAudio(),
        )
        report = coach.run()
        assert report.processed == 1
    finally:
        monkeypatch_grounded.undo()

# ---------------------------------------------------------------------------
# Regression: the 0.0/9 UX bug found in lead review before deployment.
# lib/coach.ts unconditionally formats row.pronunciation.band.toFixed(1) into
# the evidence string ("发音专项暂定 X/9"). PRONUNCIATION_HINTS_ENABLED=false
# only hides the error-hint cards, NOT that string. So the grounded path must
# emit no pronunciation object at all, while still linking the recording.
# ---------------------------------------------------------------------------


def test_grounded_writeback_never_carries_a_band_but_keeps_recording_link(tmp_path):
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
    }
    produced = review_speaking_grounded(
        b"raw-audio-bytes",
        attempt,
        12,
        config=grounded_config_obj(tmp_path),
        model=FakeGroundedModel(),
        workdir=tmp_path / "work",
        decode_wav=fake_decode,
    )
    validated = validate_feedback(
        produced.feedback,
        produced.evidence,
        produced.attempt,
        expected_attempt=attempt["id"],
        stage="speak",
        recording_id=RECORDING_ID,
        pronunciation=produced.pronunciation,
        audio_used=True,
        response=attempt["response"],
    )
    args = feedback_to_tool_args(
        validated, day=12, stage="speak", recording_id=RECORDING_ID, audio_used=True
    )
    assert "pronunciation" not in args, "a numeric band would render as 发音专项暂定 X/9"
    assert args["recordingId"] == RECORDING_ID, "click-to-relisten link must survive"


def test_text_writeback_still_omits_recording_id():
    """The recordingId change must not leak into text reviews."""
    from runner.content_rules import ValidatedFeedback

    value = ValidatedFeedback(
        feedback="一、评估：写作反馈。", evidence="提交的作文。", attempt="v2:write:0:abc"
    )
    args = feedback_to_tool_args(value, day=12, stage="write")
    assert "recordingId" not in args
    assert "pronunciation" not in args
