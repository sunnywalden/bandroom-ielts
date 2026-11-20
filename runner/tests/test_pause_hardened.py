"""Offline tests for the opt-in DSP-hardened pause detector and G2 calibration.

No corpus, no network, no model.  The synthetic signals are deterministic
(documented seed), so a vacuous detector (no speech, no pauses) or a
noise-fragile detector fails here rather than passing a 0 == 0 comparison.
"""
from __future__ import annotations

import wave

import numpy as np
import pytest
from scipy.signal import butter, sosfiltfilt

from analysis.scripts.g1g2_eval import run_eval as r
from runner import prosody

SR = 16000


def _band_noise(rng: np.random.Generator, n: int, low=300, high=3000) -> np.ndarray:
    white = rng.normal(0.0, 1.0, n)
    sos = butter(4, [low / (SR / 2), high / (SR / 2)], btype="bandpass", output="sos")
    return sosfiltfilt(sos, white)


def _bursts_with_pauses(*, noise_sigma: float = 0.0,
                        gaps: tuple[float, ...] = (0.7, 0.7, 0.7, 0.7)) -> np.ndarray:
    """Five 0.8 s speech-like bursts separated by ``gaps`` of silence.

    Leading/trailing silence is not a pause, so ``len(gaps) - 1`` internal
    pauses are expected.
    """
    rng = np.random.default_rng(20261119)
    speech_len = int(0.8 * SR)
    pieces = []
    for index, gap in enumerate(gaps):
        burst = _band_noise(rng, speech_len)
        burst = 0.10 * burst / max(np.sqrt(np.mean(burst**2)), 1e-12)
        pieces.append(burst)
        if index < len(gaps):
            pieces.append(np.zeros(int(gap * SR)))
    signal = np.concatenate(pieces)
    if noise_sigma > 0:
        signal = signal + rng.normal(0.0, noise_sigma, len(signal))
    return signal


def _write_wav(path, samples: np.ndarray) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


# --------------------------------------------------------------- detector
def test_hardened_detects_pauses_nonvacuously():
    detection = prosody.detect_pauses_hardened(_bursts_with_pauses(), SR)
    assert detection.pause_count == 3, [p["seconds"] for p in detection.pauses]
    assert detection.speech_seconds > 2.0
    # The 130 ms envelope smoothing trims both pause edges; the duration is
    # shorter than the true gap but must be positive and consistent.
    for pause in detection.pauses:
        assert 0.25 <= pause["seconds"] <= 0.70


def test_hardened_is_deterministic():
    samples = _bursts_with_pauses()
    first = prosody.detect_pauses_hardened(samples, SR).pauses
    second = prosody.detect_pauses_hardened(samples, SR).pauses
    assert first == second


def test_hardened_ignores_stationary_additive_noise():
    clean = prosody.detect_pauses_hardened(_bursts_with_pauses(), SR)
    noisy = prosody.detect_pauses_hardened(
        _bursts_with_pauses(noise_sigma=0.005), SR
    )
    assert noisy.pause_count == clean.pause_count
    assert abs(noisy.pause_seconds - clean.pause_seconds) / clean.pause_seconds <= 0.02


def test_hardened_silence_has_no_pauses():
    detection = prosody.detect_pauses_hardened(np.zeros(SR * 4), SR)
    assert detection.pause_count == 0
    assert detection.speech_seconds == 0.0


def test_hardened_honours_minimum_pause():
    short_gap = prosody.detect_pauses_hardened(
        _bursts_with_pauses(gaps=(0.20, 0.20, 0.20, 0.20)), SR
    )
    long_gap = prosody.detect_pauses_hardened(
        _bursts_with_pauses(gaps=(0.70, 0.70, 0.70, 0.70)), SR
    )
    assert short_gap.pause_count == 0
    assert long_gap.pause_count == 3


def test_analyze_wav_hardened_mode_is_opt_in_and_nonproduction(tmp_path):
    path = tmp_path / "bursts.wav"
    _write_wav(path, _bursts_with_pauses())
    document = prosody.analyze_wav(str(path), pause_mode="waveform_hardened",
                                   include_contour=False)
    assert document["input_mode"]["pause_mode"] == "waveform_hardened"
    assert document["fluency"]["pause_count"]["value"] == 3
    assert document["fluency"]["pause_count"]["status"] == prosody.STATUS_CONSISTENCY
    assert "not the production" in document["fluency"]["pause_count"]["caveat"]


# --------------------------------------------------------------- calibration
def test_score_pause_detections_matching_rule():
    reference = [(1.0, 1.5), (3.0, 3.4)]
    detected = [
        {"start": 1.1, "end": 1.4},   # >=50% overlap -> TP
        {"start": 3.3, "end": 3.6},   # midpoint in ref + 0.10 s -> TP
        {"start": 6.0, "end": 6.5},   # FP
    ]
    score = r.score_pause_detections(detected, reference)
    assert score["true_positives"] == 2
    assert score["false_positives"] == 1
    assert score["false_negatives"] == 0
    assert score["precision"] == pytest.approx(2 / 3, abs=1e-4)
    assert score["recall"] == 1.0


def test_calibration_bar_is_the_published_level_and_not_lowered():
    bar = r.calibration_bar({"precision": 0.8124, "recall": 0.9235, "f1": 0.8644})
    assert bar["meets_bar"] is True
    assert bar["bar"] == {"precision": 0.8124, "recall": 0.9235, "f1": 0.8644}
    below = r.calibration_bar({"precision": 0.8123, "recall": 0.9235, "f1": 0.8644})
    assert below["meets_bar"] is False


def test_hardened_detector_parameters_are_recorded():
    params = r.detector_parameters("waveform_hardened")
    for key in ("highpass_hz", "frame_seconds", "hop_seconds",
                "noise_percentile", "subtraction_beta", "low_fraction",
                "high_fraction", "smooth_frames", "min_speech_seconds"):
        assert key in params
    assert params["low_fraction"] < params["high_fraction"]
    assert "thresholds" not in params


# --------------------------------------------------------------- non-vacuity
def test_calibration_command_seals_report(tmp_path, monkeypatch):
    fake = {
        "pause_mode": "waveform_hardened",
        "aggregate": {"speakers": 1, "detected": 2, "true_positives": 1,
                      "false_positives": 1, "false_negatives": 0,
                      "precision": 0.9, "recall": 1.0, "f1": 0.9474},
        "per_speaker": {},
    }
    monkeypatch.setattr(r, "calibrate_pause_mode", lambda mode: fake)
    code = r.run_calibration_command(tmp_path, prereg_sha="test-sha",
                                     pause_mode="waveform_hardened")
    assert code == 0
    report = __import__("json").loads((tmp_path / "calibration-report.json").read_text())
    assert report["candidate"]["meets_bar"] is True
    assert (tmp_path / "calibration-raw.json").exists()
    assert (tmp_path / "SHA256SUMS").exists()


def test_tune_split_is_labelled_exploratory(tmp_path, monkeypatch):
    fake_summary = {
        "conditions": list(r.G2_CONDITIONS),
        "primary_conditions": list(r.G2_PRIMARY_CONDITIONS),
        "n_rows": 4, "n_primary_checks": 4, "n_primary_ok": 4,
        "retest_consistency": 1.0, "threshold": r.G2_THRESHOLD,
        "zero_pause_rows": 0, "invalid": False, "invalid_reason": None,
        "pass": True, "by_condition": {c: {"n": 1, "ok": 1, "consistency": 1.0,
                                           "trivial_sanity": c == "original"}
                                       for c in r.G2_CONDITIONS},
        "original_excluded_from_primary": True, "original_reason": "x",
        "descriptive": {}, "duration_metric": {}, "rows": [],
    }
    monkeypatch.setattr(r, "load_corpus",
                        lambda max_speakers: [{"id": f"s{i}"} for i in range(22)])
    monkeypatch.setattr(r, "g2_prosody_retest",
                        lambda samples, pause_mode: (fake_summary, []))
    code = r.run_g2_command(tmp_path, prereg_sha=None, max_speakers=22,
                            pause_mode="waveform_hardened", split="tune")
    assert code == 0
    report = __import__("json").loads((tmp_path / "report.json").read_text())
    assert report["verdict"] == "EXPLORATORY"
    assert report["pass"] is None
    assert report["gate_eligible"] is False


def test_vacuous_row_cannot_pass_even_if_marked_ok():
    rows = [{"cond": cond, "ok": True, "pause_count_orig": 0,
             "pause_iou": {"mean": None, "min": None}, "snr_db": None}
            for cond in r.G2_CONDITIONS]
    summary = r.summarize_g2(rows, r.G2_CONDITIONS, r.G2_PRIMARY_CONDITIONS)
    assert summary["zero_pause_rows"] == 4
    assert summary["pass"] is False