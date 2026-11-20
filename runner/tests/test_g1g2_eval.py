"""Offline tests for the G1 full-protocol + G2 gap-fill evaluation driver.

No network, no model calls, no corpus dependency (except a tiny synthetic WAV).
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

import analysis.scripts.g1g2_eval.run_eval as run_eval
from analysis.scripts.g1g2_eval import run_eval as r


# --------------------------------------------------------------- G2 metrics
def test_interval_iou_exact_partial_disjoint():
    a = {"start": 0.0, "end": 1.0}
    assert r.interval_iou(a, a) == 1.0
    assert r.interval_iou(a, {"start": 0.5, "end": 1.5}) == pytest.approx(1 / 3)
    assert r.interval_iou(a, {"start": 2.0, "end": 3.0}) == 0.0


def test_pause_boundary_iou_one_to_one_and_unmatched():
    orig = [{"start": 0.0, "end": 0.5}, {"start": 1.0, "end": 1.5}]
    deg = [{"start": 0.0, "end": 0.5}]
    result = r.pause_boundary_iou(orig, deg)
    assert result["matched"] == 1
    assert result["orig_n"] == 2 and result["deg_n"] == 1
    # denominator max(2,1)=2 -> one matched 1.0 + one unmatched 0.0
    assert result["mean"] == 0.5
    assert result["min"] == 0.0


def test_pause_boundary_iou_both_empty_is_undefined():
    result = r.pause_boundary_iou([], [])
    assert result["mean"] is None and result["min"] is None


def test_pause_duration_error_math_and_undefined():
    assert r.pause_duration_error({"pause_seconds": 1.0}, {"pause_seconds": 1.1}) == pytest.approx(0.1)
    assert r.pause_duration_error({"pause_seconds": 1.0}, {"pause_seconds": 1.0}) == 0.0
    # Zero baseline is undefined, never a perfect 0.0 match: two empty VAD
    # timelines must not score as "robust" (2026-11-19 degenerate retest=1.0).
    assert r.pause_duration_error({"pause_seconds": 0.0}, {"pause_seconds": 0.0}) is None
    assert r.pause_duration_error({"pause_seconds": 0.0}, {"pause_seconds": 0.5}) is None


def _write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(pcm.tobytes())


def test_measured_snr_math(tmp_path):
    signal = np.full(16000, 0.5, dtype=np.float64)
    noise = np.full(16000, 0.05, dtype=np.float64)
    sig_path, noise_path = tmp_path / "sig.wav", tmp_path / "noise.wav"
    _write_wav(sig_path, signal)
    _write_wav(noise_path, noise)
    snr = r.measured_snr_db(sig_path, noise_path)
    assert snr == pytest.approx(20.0, abs=0.1)


def test_original_condition_is_identity(tmp_path):
    orig = tmp_path / "orig.wav"
    orig.write_bytes(b"x")
    deg, info = r.degrade_audio("original", orig, tmp_path)
    assert deg == orig
    assert info["trivial"] is True


def test_ogg_uses_existing_64k_ffmpeg_path(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        Path(cmd[-1]).write_bytes(b"x")

    monkeypatch.setattr(r.subprocess, "run", fake_run)
    orig = tmp_path / "orig.wav"
    orig.write_bytes(b"x")
    deg, _info = r.degrade_audio("ogg", orig, tmp_path)
    assert deg.name == "deg_ogg.wav"
    assert calls[0][-1].endswith("lossy.ogg")
    assert "64k" in calls[0] and "-b:a" in calls[0]
    assert len(calls) == 2


def test_g2_summary_excludes_original_from_primary():
    def row(cond, ok, snr=None):
        return {"cond": cond, "ok": ok, "snr_db": snr,
                "pause_iou": {"mean": 1.0 if ok else 0.0, "min": 1.0 if ok else 0.0}}

    rows = [row("original", True), row("mp3", True), row("mp3", False),
            row("aac", False), row("ogg", True), row("noise", True, snr=18.0)]
    summary = r.summarize_g2(rows, r.G2_CONDITIONS, r.G2_PRIMARY_CONDITIONS)
    # degraded: 3 ok / 5 checks
    assert summary["n_primary_checks"] == 5
    assert summary["retest_consistency"] == pytest.approx(0.6)
    assert summary["pass"] is False
    assert summary["by_condition"]["original"]["trivial_sanity"] is True
    assert summary["descriptive"]["snr_db_min"] == 18.0


def test_g2_summary_invalidates_zero_pause_vacuity():
    rows = [{"cond": cond, "ok": True, "pause_count_orig": 0,
             "pause_iou": {"mean": None, "min": None}, "snr_db": None}
            for cond in r.G2_CONDITIONS]
    summary = r.summarize_g2(rows, r.G2_CONDITIONS, r.G2_PRIMARY_CONDITIONS)
    assert summary["zero_pause_rows"] == 4
    assert summary["invalid"] is True
    assert summary["pass"] is False
    assert "vacuous" in summary["invalid_reason"]


def test_g2_fail_closed_when_vad_model_missing(tmp_path):
    with pytest.raises(r.EvalError):
        r.g2_prosody_retest([], vad_model_path=tmp_path / "missing.onnx")


# --------------------------------------------------------------- G1 anchors
def test_parse_evidence_backing():
    text = ("录音 x；已校准韵律证据：总时长 3.20 秒，语音 2.50 秒，"
            "停顿 2 个、共 0.70 秒（停顿阈值倍数 1.60）。")
    parsed = r.parse_evidence_backing(text)
    assert parsed == {"total_seconds": 3.2, "speech_seconds": 2.5,
                      "pause_count": 2, "pause_seconds": 0.7}
    assert all(v is None for v in r.parse_evidence_backing("no backing").values())


def test_calibrated_prosody_backing_detects_mismatch(tmp_path, monkeypatch):
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    monkeypatch.setattr(r.ga, "decode_to_wav", lambda raw, wd: (Path("src"), Path("decoded")))
    monkeypatch.setattr(r.ga, "analyze_calibrated", lambda path, **kw: {"calibrated": {
        "total_duration_seconds": 3.2, "speech_duration_seconds": 2.5,
        "pause_count": 3, "pause_seconds": 0.7}})
    sample = {"id": "a", "audio_file": "a.wav", "evidence":
              "已校准韵律证据：总时长 3.20 秒，语音 2.50 秒，停顿 2 个、共 0.70 秒"}
    ok, detail = r.calibrated_prosody_backing(sample, tmp_path)
    assert ok is False
    assert detail["reason"] == "evidence_backing_mismatch"
    assert detail["evidence_parsed"]["pause_count"] == 2
    assert detail["recomputed"]["pause_count"] == 3


def test_l0_fails_closed_without_citation_anchor(tmp_path):
    samples = [{"id": "x", "stage": "write", "feedback": "", "evidence": "",
                "response_text": "", "pronunciation": None}]
    l0 = r.evaluate_l0(samples, tmp_path, {})
    assert l0["pass"] is False
    assert l0["anchor_coverage"] == "partial"
    assert any("citation_anchor_unchecked" in issue
               for rec in l0["records"] for issue in rec["issues"])


def test_l0_hjk_corpus_id_collision_is_out_of_scope(tmp_path):
    # L2-ARCTIC contains a speaker id "hjk"; the HJK fixture anchor is
    # out-of-scope, so the driver must not fail L0 on the id collision.
    samples = [{"id": "hjk", "stage": "write", "feedback": "clear feedback",
                "evidence": "", "response_text": "some transcript words here",
                "pronunciation": None}]
    l0 = r.evaluate_l0(samples, tmp_path, {})
    assert not any("no_truth_anchor_hit" in i
                   for rec in l0["records"] for i in rec["issues"])
    assert l0["pass"] is True


# --------------------------------------------------------------- G1 wiring
def test_model_set_flattens_panel_lists():
    assert r._model_set({"text": ["a", "b"], "audio": "c", "coach": "a"}) == ["a", "b", "c"]


def test_no_hardcoded_layer_inputs_in_source():
    source = Path(run_eval.__file__).read_text()
    for forbidden in ("l0_pass=True", "anchor_full=True",
                      "l3_pass=True", "escalate=False"):
        assert forbidden not in source, f"hard-coded decide input: {forbidden}"


@pytest.mark.parametrize("field,value,expected", [
    ("l0_pass", False, "FAIL"),
    ("anchor_full", False, "FAIL"),
    ("l1_pass", False, "FAIL"),
    ("l3_pass", False, "FAIL"),
    ("escalate", True, "ESCALATE"),
    ("missing", True, "ERROR"),
])
def test_compose_verdict_propagates_every_computed_layer(monkeypatch, field, value, expected):
    seen = {}

    def spy(**kwargs):
        seen.update(kwargs)
        return (expected, None)

    monkeypatch.setattr(r.g1r, "decide", spy)
    base = dict(missing=False, l0_pass=True, anchor_full=True, l1_pass=True,
                l3_pass=True, escalate=False, underpowered=False)
    base[field] = value
    verdict = r.compose_verdict(r.ProtocolResult(**base))
    assert verdict[0] == expected
    assert seen[field] is value


def test_execute_g1_invokes_l0_l1_l3_and_arbitration(monkeypatch):
    calls = []

    def fake_regen(samples, audio_dir, model):
        calls.append("regenerate")
        return samples, []

    def fake_l0(samples, audio_dir, truth):
        calls.append("l0")
        return {"pass": True, "anchor_coverage": "full"}

    def fake_l1(samples, audio_dir, evidence):
        calls.append("l1")
        return {"pass": True, "audio_verify": {}, "disagreements": []}

    def fake_l3(samples, evidence, audio_verify):
        calls.append("l3")
        return {"pass": True}

    def fake_arb(samples, disagreements, evidence):
        calls.append("arbitration")
        return {"unresolved": [{"reason": "spread_gt_1"}]}

    run = r.execute_g1(
        [{"id": "a"}], Path("."), prereg_sha="sha",
        model_ids={"text": "m"},
        preflight_fn=lambda ids: {"ok": True},
        regenerate_fn=fake_regen, l0_fn=fake_l0, l1_fn=fake_l1,
        l3_fn=fake_l3, arbitration_fn=fake_arb,
    )
    assert calls == ["regenerate", "l0", "l1", "l3", "arbitration"]
    assert run["verdict"] == "ESCALATE"
    assert run["result"].underpowered is True


def test_execute_g1_fails_closed_on_preflight(monkeypatch):
    called = []
    run = r.execute_g1(
        [{"id": "a"}], Path("."), prereg_sha="sha",
        model_ids={"text": "m"},
        preflight_fn=lambda ids: {"ok": False, "errors": {"m": "dead"}},
        regenerate_fn=lambda *a: called.append("regenerate") or ([], []),
    )
    assert run["error"] == "model_preflight_failed"
    assert called == []