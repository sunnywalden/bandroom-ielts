"""Per-user pause calibration: bounds, collapse guard, reliability disclosure."""

from __future__ import annotations

import math
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from runner import grounded_audio
from runner.grounded_audio import (
    analyze_calibrated,
    build_evidence_document,
    review_speaking_grounded,
)
from runner.pause_calibration import (
    COLLAPSE_FLOOR,
    DEFAULT_MULTIPLIER,
    MIN_LABELS,
    VALID_MAX_MULTIPLIER,
    VALID_MIN_MULTIPLIER,
    PauseCalibrationStore,
    calibrate_pause_multiplier,
    clamp_multiplier,
    reliability_disclosure,
    reliability_document,
    wilson_interval,
)

RECORDING_ID = "9b2f6f2e-2a6c-4f1b-8a2d-0f8e5a5a5a5a"


def verdicts(confirmed: int, rejected: int, *, multiplier: float | None = None):
    return [
        {"verdict": "confirmed", "multiplier": multiplier}
        for _ in range(confirmed)
    ] + [
        {"verdict": "rejected", "multiplier": multiplier}
        for _ in range(rejected)
    ]


def make_wav(path: Path, *, seconds: float = 6.0, sample_rate: int = 16000) -> Path:
    """Speech at 0.12, a low-level noise-only 'pause' at 2-3 s."""
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    speech = 0.12 * np.sin(2 * math.pi * 220.0 * t)
    noise = 0.006 * np.sin(2 * math.pi * 440.0 * t)
    samples = np.where((t >= 2.0) & (t < 3.0), noise, speech)
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


class FakeGroundedModel:
    provider = "fake"

    def __init__(self):
        self.calls = []

    def complete_grounded(self, system, user):
        self.calls.append(user)
        return (
            "一、评估：本次只依据已校准的韵律证据评估，未发现可核实的音素错误。\n"
            "二、精确引文：你提交的句子是“I think this is fine”。\n"
            "三、建议改写：可以保持原句，无需针对音素错误改写。\n"
            "四、修改原因：\n1. 在 2.00–2.98 秒处有约 0.98 秒停顿。\n"
            "五、下一步：只练一个微练习：把停顿压到 0.5 秒内。\n"
        )


def test_default_until_enough_labels():
    for count in range(MIN_LABELS):
        state = calibrate_pause_multiplier(verdicts(count, 0))
        assert state.multiplier == DEFAULT_MULTIPLIER
        assert state.source == "default_insufficient_labels"
        assert state.labels == count
    state = calibrate_pause_multiplier(verdicts(MIN_LABELS, 0))
    assert state.source == "learned"
    assert state.multiplier == DEFAULT_MULTIPLIER  # all confirmed: keep shipped


def test_low_precision_lowers_the_multiplier_but_not_below_collapse():
    state = calibrate_pause_multiplier(verdicts(0, 20))
    assert state.source == "learned"
    assert VALID_MIN_MULTIPLIER <= state.multiplier < DEFAULT_MULTIPLIER
    assert state.multiplier >= COLLAPSE_FLOOR
    assert state.collapse_guarded is True

    # Even an absurd calibration estimate is clamped.
    assert clamp_multiplier(-99) == COLLAPSE_FLOOR
    assert clamp_multiplier(99) == VALID_MAX_MULTIPLIER
    assert clamp_multiplier(float("nan")) == DEFAULT_MULTIPLIER


def test_high_precision_keeps_the_default():
    state = calibrate_pause_multiplier(verdicts(12, 0))
    assert state.multiplier == DEFAULT_MULTIPLIER
    assert state.precision == 1.0


def test_wilson_interval_is_sane():
    low, high = wilson_interval(5, 5)
    assert 0.0 <= low < 1.0 and high == 1.0
    low, high = wilson_interval(0, 5)
    assert low == 0.0 and 0.0 < high < 1.0


def test_disclosure_contains_macro_range_and_within_recording_caveat():
    default = reliability_disclosure(calibrate_pause_multiplier([]), pause_count=7)
    assert "0.8124" in default
    assert "0.333" in default and "1.000" in default
    assert "同一段录音" in default
    assert "跨会话泛化" in default
    assert "1.60" in default

    learned = reliability_disclosure(
        calibrate_pause_multiplier(verdicts(2, 5)), pause_count=7
    )
    assert "阈值倍数" in learned
    assert "95% CI" in learned


def test_reliability_document_exposes_state_and_estimate():
    state = calibrate_pause_multiplier(verdicts(1, 6), user_id="owner")
    document = reliability_document(state, pause_count=4)
    assert document["userId"] == "owner"
    assert document["multiplier"] == state.multiplier
    assert document["multiplierSource"] == "learned"
    assert document["validRange"] == [VALID_MIN_MULTIPLIER, VALID_MAX_MULTIPLIER]
    assert document["collapseGuarded"] is True
    assert document["withinRecordingOnly"] is True
    assert document["populationMacroPrecision"] == 0.8124
    assert document["pauseCountInThisRecording"] == 4


def test_store_deduplicates_replays_and_persists(tmp_path):
    path = tmp_path / "pause_calibration.json"
    store = PauseCalibrationStore(path)
    item = {"candidateId": "c1", "verdict": "confirmed", "multiplier": 1.6}
    store.record("owner", [item, item])
    store.record("owner", [dict(item, verdict="rejected")])  # duplicate id ignored
    store.save()

    reloaded = PauseCalibrationStore(path)
    assert reloaded.verdicts("owner") == [
        {"candidateId": "c1", "verdict": "confirmed", "multiplier": 1.6, "atMs": None}
    ]
    assert reloaded.state("owner").labels == 1


def test_store_ignores_malformed_and_caps_history(tmp_path):
    store = PauseCalibrationStore(tmp_path / "state.json")
    store.record("owner", [{"verdict": "maybe"}, "confirmed", {"verdict": "rejected"}])
    assert len(store.verdicts("owner")) == 2
    for index in range(600):
        store.record(
            "owner",
            [{"candidateId": f"c{index}", "verdict": "confirmed"}],
        )
    assert len(store.verdicts("owner")) == 500


def test_multiplier_is_threaded_into_detection(tmp_path):
    wav = make_wav(tmp_path / "six.wav")
    high = analyze_calibrated(wav, pause_low_noise_multiplier=1.6)
    low = analyze_calibrated(wav, pause_low_noise_multiplier=0.9)
    assert high["pause_low_noise_multiplier"] == 1.6
    assert low["pause_low_noise_multiplier"] == 0.9
    # Raising the multiplier admits more frames as silence; lowering it below
    # the measured range toward the collapse point removes the detection.
    assert high["calibrated"]["pause_count"] >= 1
    assert low["calibrated"]["pause_count"] == 0


def test_evidence_document_carries_calibration_and_reliability():
    state = calibrate_pause_multiplier(verdicts(1, 6))
    analysis = {"calibrated": {"pause_count": 3, "pauses": []}}
    document = build_evidence_document(
        analysis,
        reliability=reliability_document(state, pause_count=3),
    )
    assert document["t1_reliability"]["multiplier"] == state.multiplier
    assert document["t1_reliability"]["withinRecordingOnly"] is True
    assert document["t1_reliability"]["pauseCountInThisRecording"] == 3


def test_review_uses_personal_calibration_and_persists_verdicts(tmp_path):
    model = FakeGroundedModel()
    config = SimpleNamespace(
        grounded=grounded_audio.GroundedConfig(
            acoustic_python=tmp_path / "missing",
            staging_dir=tmp_path / "stage",
            detector_cache_dir=tmp_path / "cache",
        ),
        state_dir=tmp_path / "state",
    )
    attempt = {
        "id": "v2:speak:0:abc",
        "stage": "speak",
        "recordingId": RECORDING_ID,
        "response": "I think this is fine.",
        "userId": "owner",
        "pauseConfirmations": verdicts(0, 8),
    }
    produced = review_speaking_grounded(
        b"raw",
        attempt,
        12,
        config=config,
        model=model,
        workdir=tmp_path / "work",
        decode_wav=fake_decode,
    )
    assert "【T1 可靠性披露】" in produced.feedback
    # 1.6 stays the default until enough labels; 8 rejections is enough and the
    # multiplier is lowered, but never below the collapse floor.
    prompt = model.calls[0]
    evidence = prompt.split("【学习者提交", 1)[0]
    assert '"t1_reliability"' in evidence
    assert '"multiplierSource": "learned"' in evidence
    assert (tmp_path / "state" / "pause_calibration.json").exists()