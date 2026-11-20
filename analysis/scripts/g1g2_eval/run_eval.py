#!/usr/bin/env python3
"""G1/G2 rev3 evaluation driver. Offline except for DashScope judge calls.

Corpus: local L2-ARCTIC (22 speakers, CC BY-NC; personal/non-commercial eval
only, not redistributed).  The corpus substitution (SpeechOcean762 -> L2-ARCTIC)
is owner-approved and frozen in the iteration-28 preregistrations under the
private acceptance workspace; it is not embedded here.

Two single-run commands:

  # G2 gap-fill (local, zero marginal cost; no API key needed)
  python3 run_eval.py --vad --g2-only --prereg <G2 prereg> --out <G2 out dir>

  # G1 full protocol (paid; fixed cross-family panel)
  python3 run_eval.py --g1-only --prereg <G1 prereg> --out <G1 out dir>

The G1 driver executes every preregistered layer: L0 objective checks + quote
policy + aligned-scope check + calibrated-prosody backing anchor, L1 panel and
reliability, L3 corroborated red team, and arbitration.  It never passes a
hard-coded layer input to ``g1r.decide``; see ``ProtocolResult``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from runner import gate1_restructured as g1r  # noqa: E402
from runner import gate1_auto as ag1  # noqa: E402
from runner import grounded_audio as ga  # noqa: E402
from runner import prosody  # noqa: E402
from runner.models.qwen import QwenAdapter  # noqa: E402

BASE = Path(os.environ.get("BANDROOM_ACOUSTIC_DIR", str(Path.home() / ".bandroom-acoustic")))
CORPUS = BASE / "corpus" / "suitcase_corpus"
VAD_MODEL = BASE / "silero_vad.onnx"
FFMPEG = os.environ.get("BANDROOM_FFMPEG", "/opt/homebrew/bin/ffmpeg")
SEED = 20261119
EXPECTED_SPEAKERS = 22

# Frozen G2 protocol constants (inherited; not lowered).
G2_CONDITIONS = ("original", "mp3", "aac", "ogg", "noise")
G2_PRIMARY_CONDITIONS = ("mp3", "aac", "ogg", "noise")
G2_THRESHOLD = 0.9
G2_PAUSE_DURATION_MAX_ERROR = 0.02
NOISE_AMPLITUDE = 0.01
NOISE_SEED = 20261119

# Frozen VAD thresholds (runner/prosody.py constants, repeated for the report).
VAD_THRESHOLDS = {"thr": 0.5, "neg": 0.35, "min_speech": 0.25}

# Detector modes.  ``waveform_hardened`` is the iteration-29 F2 DSP research
# mode; it is opt-in and never the production default.
DETECTOR_MODES = ("vad", "waveform_only", "waveform_hardened")

# Iteration-25 human-annotation calibration reference (shipped waveform_only).
CALIBRATION_REFERENCE = {
    "precision": 0.8124, "recall": 0.9235, "f1": 0.8644,
    "speakers": 22, "reference_pauses": 497, "detected": 565,
}
CALIBRATION_MATCH_TOLERANCE = 0.10
CALIBRATION_MIN_PAUSE = 0.32


def detector_parameters(pause_mode: str) -> dict:
    """Frozen detector parameters recorded in the report and raw evidence."""
    if pause_mode == "vad":
        return {"model": "silero_vad.onnx", "model_sha256": sha256_file(VAD_MODEL),
                "thresholds": VAD_THRESHOLDS}
    if pause_mode == "waveform_hardened":
        return {
            "highpass_hz": prosody.HARDENED_HIGHPASS_HZ,
            "frame_seconds": prosody.HARDENED_FRAME_SECONDS,
            "hop_seconds": prosody.HARDENED_HOP_SECONDS,
            "noise_percentile": prosody.HARDENED_NOISE_PERCENTILE,
            "subtraction_beta": prosody.HARDENED_SUBTRACTION_BETA,
            "level_percentile": prosody.HARDENED_LEVEL_PERCENTILE,
            "low_fraction": prosody.HARDENED_LOW_FRACTION,
            "high_fraction": prosody.HARDENED_HIGH_FRACTION,
            "smooth_frames": prosody.HARDENED_SMOOTH_FRAMES,
            "bridge_seconds": prosody.HARDENED_BRIDGE_SECONDS,
            "bridge_fraction": prosody.HARDENED_BRIDGE_FRACTION,
            "min_speech_seconds": prosody.HARDENED_MIN_SPEECH_SECONDS,
            "min_pause_seconds": prosody.PAUSE_MIN_SECONDS,
        }
    return {
        "frame_seconds": prosody.ENERGY_FRAME_SECONDS,
        "hop_seconds": prosody.ENERGY_HOP_SECONDS,
        "noise_percentile": prosody.NOISE_PERCENTILE,
        "low_noise_multiplier": prosody.PAUSE_LOW_NOISE_MULTIPLIER,
        "high_noise_multiplier": prosody.PAUSE_HIGH_NOISE_MULTIPLIER,
        "bridge_max_seconds": prosody.PAUSE_BRIDGE_MAX_SECONDS,
        "bridge_noise_multiplier": prosody.PAUSE_BRIDGE_NOISE_MULTIPLIER,
        "min_pause_seconds": prosody.PAUSE_MIN_SECONDS,
    }

# Anchored rubric used for the panel (frozen in the G1 prereg).
ANCHORED_TEXT_RUBRIC = ag1.RUBRIC + """
Anchors (reduce judge spread):
 evidence: 1=generic no quotes; 3=partial quotes; 5=precise verbatim quotes + localization.
 correction: 1=contains wrong corrections; 3=mostly correct; 5=all correct with sound reasons.
 explanation: 1=vague; 3=clear; 5=clear + reasons + learner perspective.
 next_step: 1=none/vague; 3=a suggestion; 5=one concrete immediately practicable drill.
"""

EVIDENCE_TOTAL = re.compile(r"总时长\s*([\d.]+)\s*秒")
EVIDENCE_SPEECH = re.compile(r"语音\s*([\d.]+)\s*秒")
EVIDENCE_PAUSE = re.compile(r"停顿\s*(\d+)\s*个、共\s*([\d.]+)\s*秒")


class EvalError(RuntimeError):
    """Fail-closed evaluation error."""


# --------------------------------------------------------------- utilities
def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def canonical_sha256(obj) -> str:
    return sha256_bytes(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode())


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1))


def seal_dir(out: Path) -> dict:
    """Write SHA256SUMS over every regular file except the seal itself."""
    sums = {f.name: sha256_file(f) for f in sorted(out.iterdir())
            if f.is_file() and f.name != "SHA256SUMS"}
    (out / "SHA256SUMS").write_text("".join(f"{h}  {n}\n" for n, h in sums.items()))
    return sums


def load_prereg_sha(path: str | None) -> str | None:
    return sha256_file(Path(path)) if path else None


# --------------------------------------------------------------- corpus
def load_corpus(max_speakers: int = EXPECTED_SPEAKERS) -> list[dict]:
    wavs = sorted((CORPUS / "wav").glob("*.wav"))
    if not wavs:
        raise EvalError(f"corpus missing: {CORPUS / 'wav'}")
    missing_tx = [w.stem for w in wavs if not (CORPUS / "transcript" / f"{w.stem}.txt").exists()]
    if missing_tx:
        raise EvalError(f"corpus transcripts missing for: {','.join(missing_tx[:5])}")
    samples = []
    for w in wavs[:max_speakers]:
        spk = w.stem
        resp = (CORPUS / "transcript" / f"{spk}.txt").read_text().strip()
        samples.append({"id": spk, "stage": "speak", "audio_file": w.name,
                        "response_text": resp, "feedback": "", "evidence": "",
                        "pronunciation": None,
                        "context_text": "L2-ARCTIC read/narrative (eval)."})
    return samples


# --------------------------------------------------------------- G2 metrics
def interval_iou(a: dict, b: dict) -> float:
    start = max(float(a["start"]), float(b["start"]))
    end = min(float(a["end"]), float(b["end"]))
    inter = max(0.0, end - start)
    union = (max(float(a["end"]), float(b["end"]))
             - min(float(a["start"]), float(b["start"])))
    return inter / union if union > 0 else 0.0


def pause_boundary_iou(orig_pauses: list, deg_pauses: list) -> dict:
    """One-to-one greedy IoU over pause intervals; unmatched pauses score 0.

    Descriptive only (the protocol names IoU without a pass/fail bar).  The
    denominator is max(#orig, #deg) so a split/merge is penalised.  Both empty
    is undefined -> None.
    """
    if not orig_pauses and not deg_pauses:
        return {"mean": None, "min": None, "matched": 0,
                "orig_n": 0, "deg_n": 0, "note": "both timelines empty"}
    pairs = []
    for i, a in enumerate(orig_pauses):
        for j, b in enumerate(deg_pauses):
            pairs.append((interval_iou(a, b), i, j))
    pairs.sort(reverse=True)
    used_o, used_d, ious = set(), set(), []
    for iou, i, j in pairs:
        if i in used_o or j in used_d:
            continue
        used_o.add(i); used_d.add(j); ious.append(iou)
    denom = max(len(orig_pauses), len(deg_pauses))
    padded = ious + [0.0] * (denom - len(ious))
    return {"mean": round(statistics.mean(padded), 4) if padded else None,
            "min": round(min(padded), 4) if padded else None,
            "matched": len(ious), "orig_n": len(orig_pauses),
            "deg_n": len(deg_pauses)}


def pause_duration_error(orig_cal: dict, deg_cal: dict) -> float | None:
    """|sum(pause_seconds_orig) - sum(pause_seconds_deg)| / pause_seconds_orig.

    A zero-pause baseline makes the relative error UNDEFINED, never 0.0: the
    old ``0.0 if d <= 0`` branch let two empty (degenerate) VAD timelines score
    a perfect robustness match, which is how the 2026-11-19 all-zero speech
    outage shipped "validated" (retest=1.0).
    """
    o = float(orig_cal.get("pause_seconds") or 0.0)
    d = float(deg_cal.get("pause_seconds") or 0.0)
    if o <= 0:
        return None
    return abs(o - d) / o


def whole_file_duration_error(orig_cal: dict, deg_cal: dict) -> float | None:
    """Secondary disclosure only (near-vacuous for lossy transcodes)."""
    o = float(orig_cal.get("total_duration_seconds") or 0.0)
    d = float(deg_cal.get("total_duration_seconds") or 0.0)
    if o <= 0:
        return None
    return abs(o - d) / o


def _pcm_samples(path: Path) -> np.ndarray:
    """Raw 16-bit mono PCM as float64 (no mean-centering)."""
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2 or handle.getnchannels() != 1:
            raise ValueError("SNR measurement requires 16-bit mono PCM")
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0


def measured_snr_db(signal_path: Path, noise_path: Path) -> float | None:
    sig = _pcm_samples(signal_path)
    noise = _pcm_samples(noise_path)
    n = min(len(sig), len(noise))
    if n <= 0:
        return None
    sig_power = float(np.mean(np.square(sig[:n], dtype=np.float64)))
    noise_power = float(np.mean(np.square(noise[:n], dtype=np.float64)))
    if sig_power <= 0 or noise_power <= 0:
        return None
    return round(10.0 * math.log10(sig_power / noise_power), 3)


def degrade_audio(cond: str, orig: Path, workdir: Path) -> tuple[Path, dict]:
    """Build one condition. ``original`` is an identity sanity row."""
    if cond == "original":
        return orig, {"construction": "identity (undegraded sanity row)",
                      "trivial": True}
    if cond == "noise":
        duration = prosody.load_wav(orig).duration
        noise = workdir / "noise.wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                        (f"anoisesrc=color=white:amplitude={NOISE_AMPLITUDE}"
                         f":duration={duration:.3f}:seed={NOISE_SEED}"),
                        "-ar", "16000", "-ac", "1", str(noise)],
                       check=True, capture_output=True)
        deg = workdir / "deg_noise.wav"
        subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(orig),
                        "-i", str(noise), "-filter_complex",
                        "amix=inputs=2:duration=first", "-ar", "16000", "-ac", "1",
                        str(deg)], check=True, capture_output=True)
        return deg, {"construction": "white anoisesrc amplitude=0.01 + amix",
                     "amplitude": NOISE_AMPLITUDE, "seed": NOISE_SEED,
                     "noise_file": str(noise), "trivial": False}
    lossy = workdir / f"lossy.{cond}"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(orig),
                    "-b:a", "64k", str(lossy)], check=True, capture_output=True)
    deg = workdir / f"deg_{cond}.wav"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(lossy),
                    "-ar", "16000", "-ac", "1", str(deg)],
                   check=True, capture_output=True)
    return deg, {"construction": f"{cond} 64k then 16k mono",
                 "trivial": False}


def analyze_pauses(path: Path, pause_mode: str) -> dict:
    # Instrument measurement, NOT coaching presentation: read raw envelope
    # values regardless of calibration status. ga.analyze_calibrated is the
    # learner-facing gate and fail-closes on consistency_checked vad metrics;
    # the eval must still be able to measure that mode's behaviour.
    doc = prosody.analyze_wav(str(path), pause_mode=pause_mode, include_contour=False)
    fluency = doc.get("fluency") or {}
    cal = {}
    for key, env in fluency.items():
        if prosody.is_metric(env):
            cal[key] = env.get("value")
    for key in ("pause_count", "pause_seconds", "total_duration_seconds", "pauses"):
        if cal.get(key) is None:
            raise EvalError(f"calibrated field missing: {key} for {path.name}")
    return cal


def summarize_g2(rows: list, conditions: tuple, primary_conditions: tuple) -> dict:
    by_condition = {}
    for cond in conditions:
        sub = [r for r in rows if r["cond"] == cond]
        ok = sum(1 for r in sub if r["ok"])
        by_condition[cond] = {
            "n": len(sub), "ok": ok,
            "consistency": round(ok / len(sub), 4) if sub else None,
            "trivial_sanity": cond == "original",
        }
    primary = [r for r in rows if r["cond"] in primary_conditions]
    primary_ok = sum(1 for r in primary if r["ok"])
    retest = round(primary_ok / len(primary), 4) if primary else None
    zero_pause_rows = sum(1 for r in primary if r.get("pause_count_orig") == 0)
    invalid = bool(primary) and zero_pause_rows == len(primary)
    all_consistencies = [v["consistency"] for v in by_condition.values()]
    all_conditions_ok = all(c is not None and c >= G2_THRESHOLD for c in all_consistencies)
    ios = [r["pause_iou"]["mean"] for r in rows if r["pause_iou"]["mean"] is not None]
    mins = [r["pause_iou"]["min"] for r in rows if r["pause_iou"]["min"] is not None]
    snrs = [r["snr_db"] for r in rows if r.get("snr_db") is not None]
    return {
        "conditions": list(conditions), "primary_conditions": list(primary_conditions),
        "n_rows": len(rows), "n_primary_checks": len(primary), "n_primary_ok": primary_ok,
        "retest_consistency": retest, "threshold": G2_THRESHOLD,
        "zero_pause_rows": zero_pause_rows, "invalid": invalid,
        "invalid_reason": (
            "VAD detected zero pauses in every primary row; pause_count 0==0 "
            "and pause-duration 0/0 are vacuous and cannot evidence pause "
            "stability (fail-closed validity guard, added post-run)"
        ) if invalid else None,
        "pass": bool(not invalid and retest is not None
                     and retest >= G2_THRESHOLD and all_conditions_ok
                     and zero_pause_rows == 0),
        "by_condition": by_condition,
        "original_excluded_from_primary": True,
        "original_reason": "undegraded identity row is trivially 1.0; excluded "
                           "from the primary fraction to avoid inflation, still "
                           "reported and included in the all-condition sanity check",
        "descriptive": {
            "pause_boundary_iou_mean": round(statistics.mean(ios), 4) if ios else None,
            "pause_boundary_iou_min": round(min(mins), 4) if mins else None,
            "pause_boundary_iou_note": "descriptive only; no pass/fail bar",
            "snr_db_min": min(snrs) if snrs else None,
            "snr_db_max": max(snrs) if snrs else None,
            "snr_db_mean": round(statistics.mean(snrs), 3) if snrs else None,
        },
        "duration_metric": {
            "primary": "pause-duration error = |sum pause_seconds orig - "
                       "sum pause_seconds deg| / sum pause_seconds orig <= 2%",
            "secondary": "whole-file duration error (reported, near-vacuous; "
                         "lossy transcodes preserve file length)",
        },
    }


def g2_prosody_retest(samples: list, *, pause_mode: str = "vad",
                      conditions: tuple = G2_CONDITIONS,
                      primary_conditions: tuple = G2_PRIMARY_CONDITIONS,
                      vad_model_path: Path = VAD_MODEL,
                      ) -> tuple[dict, list]:
    """Run the frozen G2 gap-fill retest. Returns (summary, raw_checks)."""
    if pause_mode == "vad" and not Path(vad_model_path).exists():
        raise EvalError(f"Silero VAD model missing: {vad_model_path}")
    if not Path(FFMPEG).exists():
        raise EvalError(f"ffmpeg missing: {FFMPEG}")
    model_sha = sha256_file(Path(vad_model_path)) if pause_mode == "vad" else None
    rows, raw_checks = [], []
    for s in samples:
        raw = (CORPUS / "wav" / s["audio_file"]).read_bytes()
        with tempfile.TemporaryDirectory() as wd:
            wd = Path(wd)
            _, orig = ga.decode_to_wav(raw, wd)
            base = analyze_pauses(orig, pause_mode)
            # Non-vacuity gate: the corpus clips are continuous speech. An
            # all-zero base speech timeline means the instrument is broken
            # (e.g. the Silero calling-convention outage), not that the
            # detector is perfectly robust. Refuse to score such rows.
            if float(base.get("speech_duration_seconds") or 0.0) <= 0.0:
                raise EvalError(
                    f"degenerate base speech timeline for {s['id']}: "
                    f"pause_mode={pause_mode} detected no speech in a speech corpus clip"
                )
            for cond in conditions:
                try:
                    deg, info = degrade_audio(cond, orig, wd)
                    deg_cal = analyze_pauses(deg, pause_mode)
                    pc_match = int(base.get("pause_count", 0)) == int(deg_cal.get("pause_count", 0))
                    pde = pause_duration_error(base, deg_cal)
                    wde = whole_file_duration_error(base, deg_cal)
                    iou = pause_boundary_iou(base.get("pauses") or [], deg_cal.get("pauses") or [])
                    snr = (measured_snr_db(orig, Path(info["noise_file"]))
                           if cond == "noise" else None)
                except (EvalError, subprocess.CalledProcessError, ValueError) as exc:
                    raise EvalError(f"G2 row failed for {s['id']}/{cond}: {exc}") from exc
                vacuous = int(base.get("pause_count", 0)) == 0
                ok = bool(pc_match and pde is not None
                          and pde <= G2_PAUSE_DURATION_MAX_ERROR and not vacuous)
                row = {
                    "speaker": s["id"], "cond": cond, "pause_match": pc_match,
                    "vacuous_base": vacuous,
                    "pause_count_orig": int(base.get("pause_count", 0)),
                    "pause_count_deg": int(deg_cal.get("pause_count", 0)),
                    "pause_seconds_orig": round(float(base.get("pause_seconds") or 0.0), 4),
                    "pause_seconds_deg": round(float(deg_cal.get("pause_seconds") or 0.0), 4),
                    "pause_duration_error": (round(pde, 5) if pde is not None else None),
                    "whole_file_duration_error": (round(wde, 5) if wde is not None else None),
                    "pause_iou": iou, "snr_db": snr, "ok": ok,
                }
                rows.append(row)
                raw_checks.append({
                    **row, "orig_pauses": base.get("pauses") or [],
                    "deg_pauses": deg_cal.get("pauses") or [],
                    "total_duration_orig": base.get("total_duration_seconds"),
                    "total_duration_deg": deg_cal.get("total_duration_seconds"),
                    "construction": info, "pause_mode": pause_mode,
                    "detector": detector_parameters(pause_mode),
                })
    summary = summarize_g2(rows, conditions, primary_conditions)
    summary["rows"] = rows
    return summary, raw_checks


# --------------------------------------------------------------- G1 anchors
# --------------------------------------------------------------- calibration
def annotation_pauses(words: list) -> list[tuple[float, float]]:
    """Human reference: gaps >= 0.32 s between consecutive annotated words."""
    return [
        (previous.end, current.start)
        for previous, current in zip(words, words[1:])
        if current.start - previous.end >= CALIBRATION_MIN_PAUSE
    ]


def score_pause_detections(detected: list, reference: list[tuple[float, float]]) -> dict:
    """Iteration-25 matching rule: >=50% overlap or midpoint within +-0.10 s."""
    used: set[int] = set()
    true_positives = 0
    for pause in detected:
        begin, finish = float(pause["start"]), float(pause["end"])
        for index, (ref_start, ref_end) in enumerate(reference):
            if index in used:
                continue
            overlap = min(finish, ref_end) - max(begin, ref_start)
            midpoint = (begin + finish) / 2.0
            if overlap >= 0.5 * (ref_end - ref_start) or (
                ref_start - CALIBRATION_MATCH_TOLERANCE
                <= midpoint
                <= ref_end + CALIBRATION_MATCH_TOLERANCE
            ):
                used.add(index)
                true_positives += 1
                break
    false_positives = len(detected) - true_positives
    false_negatives = len(reference) - true_positives
    precision = true_positives / len(detected) if detected else (
        1.0 if not reference else 0.0)
    recall = true_positives / len(reference) if reference else 1.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "detected": len(detected), "true_positives": true_positives,
        "false_positives": false_positives, "false_negatives": false_negatives,
        "precision": _round4(precision), "recall": _round4(recall),
        "f1": _round4(f1),
    }


def _round4(value: float) -> float:
    """Round to 4 dp without importing pytest (name avoids shadowing risk)."""
    return round(float(value), 4)


def pause_timeline(samples, sample_rate: int, pause_mode: str) -> list[dict]:
    if pause_mode == "vad":
        return prosody.vad_pauses(samples, sample_rate).pauses
    if pause_mode == "waveform_hardened":
        return prosody.detect_pauses_hardened(samples, sample_rate).pauses
    if pause_mode == "waveform_only":
        return prosody.detect_pauses(samples, sample_rate).pauses
    raise EvalError(f"unsupported calibration pause_mode: {pause_mode}")


def aggregate_pause_scores(rows: list[dict]) -> dict:
    detected = sum(row["detected"] for row in rows)
    tp = sum(row["true_positives"] for row in rows)
    fp = sum(row["false_positives"] for row in rows)
    fn = sum(row["false_negatives"] for row in rows)
    precision = tp / detected if detected else (1.0 if not fn else 0.0)
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"speakers": len(rows), "detected": detected, "true_positives": tp,
            "false_positives": fp, "false_negatives": fn,
            "precision": round(precision, 4), "recall": round(recall, 4),
            "f1": round(f1, 4)}


def calibrate_pause_mode(pause_mode: str) -> dict:
    """Re-measure pause P/R/F1 against the L2-ARCTIC TextGrid words tier.

    Same methodology and threshold as iteration-25 ``calibrate.py``: direct
    corpus WAVs, reference gaps >= 0.32 s, the 50%-overlap / midpoint +-0.10 s
    match rule, pooled counts.
    """
    if pause_mode == "vad" and not Path(VAD_MODEL).exists():
        raise EvalError(f"Silero VAD model missing: {VAD_MODEL}")
    wavs = sorted((CORPUS / "wav").glob("*.wav"))
    if not wavs:
        raise EvalError(f"corpus missing: {CORPUS / 'wav'}")
    rows, per_speaker = [], {}
    for path in wavs:
        speaker = path.stem
        textgrid = CORPUS / "annotation" / f"{speaker}.TextGrid"
        if not textgrid.exists():
            raise EvalError(f"annotation missing for {speaker}")
        words = prosody.parse_textgrid_words(textgrid)
        reference = annotation_pauses(words)
        audio = prosody.load_wav(path)
        detected = pause_timeline(audio.samples, audio.sample_rate, pause_mode)
        score = score_pause_detections(detected, reference)
        rows.append(score)
        per_speaker[speaker] = {
            "reference_pauses": len(reference),
            **{k: score[k] for k in ("detected", "true_positives",
                                     "false_positives", "false_negatives")},
        }
    aggregate = aggregate_pause_scores(rows)
    return {"pause_mode": pause_mode, "aggregate": aggregate,
            "per_speaker": per_speaker}


def calibration_bar(aggregate: dict) -> dict:
    """Per-metric bar inherited from the shipped waveform_only calibration."""
    checks = {key: round(float(aggregate[key]), 4) >= CALIBRATION_REFERENCE[key]
              for key in ("precision", "recall", "f1")}
    return {
        "bar": {key: CALIBRATION_REFERENCE[key]
                for key in ("precision", "recall", "f1")},
        "reference": dict(CALIBRATION_REFERENCE),
        "checks": checks,
        "meets_bar": all(checks.values()),
        "rule": "each pooled metric must be >= the iteration-25 shipped "
                "waveform_only level; no threshold lowering",
    }


def run_calibration_command(out: Path, *, prereg_sha: str | None,
                            pause_mode: str) -> int:
    if pause_mode not in DETECTOR_MODES:
        write_error_report(out, protocol="G2-prosody-calibration",
                           prereg_sha=prereg_sha,
                           error=f"invalid pause_mode: {pause_mode}")
        print("CALIBRATION ERROR: invalid pause_mode", pause_mode)
        return 3
    try:
        candidate = calibrate_pause_mode(pause_mode)
        control = calibrate_pause_mode("waveform_only")
    except (EvalError, ValueError) as exc:
        write_error_report(out, protocol="G2-prosody-calibration",
                           prereg_sha=prereg_sha, error=str(exc))
        print("CALIBRATION ERROR:", exc)
        return 3
    control_parity = all(
        abs(control["aggregate"][key] - CALIBRATION_REFERENCE[key]) <= 1e-4
        for key in ("precision", "recall", "f1")
    )
    report = {
        "protocol": "G2-prosody-calibration",
        "evaluated_at_utc": now_utc(),
        "prereg": {"doc_sha256": prereg_sha},
        "corpus": "L2-ARCTIC Suitcase, 22 speakers (CC BY-NC, eval only)",
        "corpus_license": "CC BY-NC, local evaluation only, not redistributed",
        "reference_annotation": "Praat TextGrid 'words' tier (human word boundaries)",
        "reference_definition": "gap >= 0.32 s between consecutive annotated words",
        "matching_rule": ">=50% overlap OR detection midpoint within reference "
                         "+-0.10 s; pooled counts",
        "methodology": "iteration-25/prosody/calibrate.py (direct corpus WAVs)",
        "baseline_control": {
            **control,
            "expected": dict(CALIBRATION_REFERENCE),
            "parity_with_published": control_parity,
        },
        "candidate": {**candidate, **calibration_bar(candidate["aggregate"])},
        "candidate_mode": pause_mode,
        "detector": detector_parameters(pause_mode),
        "caveats": [
            "The human annotation is the same L2-ARCTIC TextGrid set used by "
            "iteration-25; it is not an independent pause annotation for the "
            "cross-codec retest (which remains retest-only).",
            "Per-user T1 multiplier semantics were measured for waveform_only; "
            "the hardened mode's multiplier is re-derived and not validated.",
            "No threshold was lowered; the bar is the published shipped level.",
        ],
    }
    write_json(out / "calibration-report.json", report)
    write_json(out / "calibration-raw.json", {
        "protocol": "G2-prosody-calibration",
        "candidate_mode": pause_mode,
        "candidate": candidate["per_speaker"],
        "baseline_control": control["per_speaker"],
    })
    seal_dir(out)
    print("CALIBRATION", pause_mode,
          "candidate:", {k: candidate["aggregate"][k] for k in ("precision", "recall", "f1")},
          "bar_met:", report["candidate"]["meets_bar"],
          "baseline_control:", {k: control["aggregate"][k]
                                for k in ("precision", "recall", "f1")},
          "parity:", control_parity)
    return 0


def parse_evidence_backing(evidence: str) -> dict:
    total = EVIDENCE_TOTAL.search(evidence or "")
    speech = EVIDENCE_SPEECH.search(evidence or "")
    pause = EVIDENCE_PAUSE.search(evidence or "")
    return {
        "total_seconds": float(total.group(1)) if total else None,
        "speech_seconds": float(speech.group(1)) if speech else None,
        "pause_count": int(pause.group(1)) if pause else None,
        "pause_seconds": float(pause.group(2)) if pause else None,
    }


def calibrated_prosody_backing(sample: dict, audio_dir: Path) -> tuple[bool, dict]:
    """Anchor 2: the feedback must be backed by re-computable calibrated DSP.

    Recomputes ``analyze_calibrated`` with the same mode/multiplier the eval
    coach used (GroundedConfig defaults: waveform_only, multiplier 1.6) and
    requires the feedback's deterministic evidence string to match.
    """
    evidence_text = sample.get("evidence") or ""
    parsed = parse_evidence_backing(evidence_text)
    detail = {"sample": sample["id"], "evidence_parsed": parsed}
    if any(v is None for v in parsed.values()):
        detail["reason"] = "evidence_backing_missing"
        return False, detail
    try:
        raw = (audio_dir / sample["audio_file"]).read_bytes()
        with tempfile.TemporaryDirectory() as wd:
            _, decoded = ga.decode_to_wav(raw, Path(wd))
            cal = ga.analyze_calibrated(decoded, pause_mode="waveform_only")["calibrated"]
    except Exception as exc:  # noqa: BLE001 - fail closed
        detail["reason"] = f"analysis_failed:{str(exc)[:120]}"
        return False, detail
    observed = {
        "total_seconds": float(cal.get("total_duration_seconds") or 0.0),
        "speech_seconds": float(cal.get("speech_duration_seconds") or 0.0),
        "pause_count": int(cal.get("pause_count") or 0),
        "pause_seconds": float(cal.get("pause_seconds") or 0.0),
    }
    detail["recomputed"] = observed
    tol = 0.011
    ok = (
        parsed["pause_count"] == observed["pause_count"]
        and abs(parsed["total_seconds"] - observed["total_seconds"]) <= tol
        and abs(parsed["speech_seconds"] - observed["speech_seconds"]) <= tol
        and abs(parsed["pause_seconds"] - observed["pause_seconds"]) <= tol
    )
    if not ok:
        detail["reason"] = "evidence_backing_mismatch"
    return ok, detail


def evaluate_l0(samples: list, audio_dir: Path, truth: dict | None = None) -> dict:
    """Execute L0: objective checks, quote policy, scope, backing anchors."""
    truth = truth or {}
    records = g1r.apply_quote_policy(ag1.l0_checks(samples, truth))
    anchor_details, citation_checked = [], []
    anchor_full = True
    for record, sample in zip(records, samples):
        record["issues"] = list(dict.fromkeys(record.get("issues") or []))
        # L2-ARCTIC happens to contain a speaker whose id is literally "hjk".
        # The HJK fixture word-timestamp anchor is out-of-scope for this corpus
        # (no HJK truth events; PR #24 precedent), so the id collision must not
        # create a substantive L0 failure.
        if sample["id"] == "hjk" and not truth.get("events"):
            record["issues"] = [i for i in record["issues"]
                                if i != "no_truth_anchor_hit"]
        # Citation anchor is applicable whenever a transcript is present.
        citation_ok = bool(sample.get("response_text"))
        citation_checked.append(citation_ok)
        if not citation_ok:
            anchor_full = False
            record["issues"].append("citation_anchor_unchecked")
        if sample.get("stage") == "speak":
            # Deterministic aligned-scope anchor.
            violations = g1r.aligned_scope_violations(sample.get("feedback", ""))
            if violations:
                record["issues"].append("aligned_scope_violation:" + ",".join(violations))
            # Calibrated-prosody backing anchor.
            if not sample.get("feedback") or not sample.get("evidence"):
                anchor_full = False
                record["issues"].append("calibrated_prosody_backing:missing_feedback_or_evidence")
                anchor_details.append({"sample": sample["id"],
                                       "reason": "missing_feedback_or_evidence"})
            else:
                ok, detail = calibrated_prosody_backing(sample, audio_dir)
                anchor_details.append(detail)
                if not ok:
                    record["issues"].append(
                        "calibrated_prosody_backing:" + detail.get("reason", "failed"))
                    # A mismatch is a checked-but-failed anchor (L0 blocking);
                    # only an uncheckable anchor reduces coverage.
                    if detail.get("reason") != "evidence_backing_mismatch":
                        anchor_full = False
        record["issues"] = list(dict.fromkeys(record["issues"]))
        record["pass"] = not record["issues"]
    l0_pass = all(r["pass"] for r in records)
    return {
        "pass": l0_pass,
        "anchor_coverage": "full" if anchor_full else "partial",
        "anchor_set": [
            "citation_verification (learner-quote ratio; <0.2 blocking, 0.2-0.4 advisory)",
            "calibrated_prosody_backing (independent waveform_only DSP vs feedback evidence)",
            "deterministic_aligned_scope (phoneme/IPA/stress/band/pitch/rate claims)",
        ],
        "anchor_out_of_scope": [
            "HJK word-timestamp anchor (no HJK sample in L2-ARCTIC; PR #24 precedent)",
        ],
        "citation_checked": all(citation_checked),
        "calibrated_prosody_backing": anchor_details,
        "records": records,
        "issues": [{"id": r["id"], "issues": r["issues"]}
                   for r in records if r["issues"]],
    }


def evaluate_l1(samples: list, audio_dir: Path, evidence: list) -> dict:
    """Execute the L1 cross-family text panel + aligned audio evidence layer."""
    original_rubric = ag1.RUBRIC
    ag1.RUBRIC = ANCHORED_TEXT_RUBRIC
    try:
        l1_text = ag1.run_text_judges(samples, evidence, "L1")
        l1_audio = g1r.run_audio_judge_aligned(samples, audio_dir, evidence)
    finally:
        ag1.RUBRIC = original_rubric

    # Audio dims are distinct single-judge dims, never repeated judges.
    for sid, dims in l1_audio.get("dims", {}).items():
        for dim, value in dims.items():
            l1_text["scores"].setdefault(sid, {})[dim] = [value]

    agree = g1r.within1_agreement(l1_text["scores"])
    sample_means, disagreements = {}, []
    audio_criticals, audio_scope = [], []
    text_dims = ("evidence", "correction", "explanation", "next_step")
    audio_dims = ("prosody_validity", "localization", "actionability", "restraint")
    text_values, audio_values = [], []
    for sample in samples:
        sid = sample["id"]
        dims = l1_text["scores"].get(sid, {})
        medians = {}
        for dim, values in dims.items():
            if len(values) >= 2 and (max(values) - min(values)) > 1.0:
                disagreements.append({"sample": sid, "dim": dim, "scores": values})
            medians[dim] = statistics.median(values) if values else None
        nums = [v for v in medians.values() if v is not None]
        critics = l1_text["criticals"].get(sid, [])
        sample_means[sid] = {
            "dims": medians,
            "mean": round(statistics.mean(nums), 3) if nums else None,
            "critical_judges": critics,
            "critical_majority": g1r.critical_majority(critics),
        }
        text_med = [medians[d] for d in text_dims if medians.get(d) is not None]
        audio_med = [medians[d] for d in audio_dims if medians.get(d) is not None]
        if text_med:
            text_values.append(statistics.mean(text_med))
        if audio_med:
            audio_values.append(statistics.mean(audio_med))
        if sid in l1_audio.get("criticals", {}):
            audio_criticals.append(sid)
            audio_scope.append({"sample": sid,
                                "critical": True,
                                "scope_violations": l1_audio.get("verify", {}).get(sid, [])})
        elif l1_audio.get("verify", {}).get(sid):
            audio_scope.append({"sample": sid, "critical": False,
                                "scope_violations": l1_audio.get("verify", {}).get(sid)})

    means = [m["mean"] for m in sample_means.values() if m["mean"] is not None]
    overall = round(statistics.mean(means), 3) if means else None
    ci = g1r.bootstrap_ci(means)
    critical_count = sum(1 for m in sample_means.values() if m["critical_majority"])
    agree_ok = (agree["within1_fraction"] is not None
                and agree["within1_fraction"] >= g1r.WITHIN1_MIN)
    l1_pass = (overall is not None and overall >= 3.5
               and critical_count <= 1 and agree_ok)
    return {
        "sample_means": sample_means,
        "overall_mean": overall,
        "overall_mean_ci": ci,
        "text_only_mean": round(statistics.mean(text_values), 3) if text_values else None,
        "audio_only_mean": round(statistics.mean(audio_values), 3) if audio_values else None,
        "reliability": agree,
        "reliability_ok": agree_ok,
        "critical_majority_count": critical_count,
        "audio_criticals": audio_criticals,
        "audio_scope_violations": audio_scope,
        "audio_verify": l1_audio.get("verify", {}),
        "disagreements": disagreements,
        "pass": l1_pass,
        "n": len(samples),
    }


def evaluate_l3(samples: list, evidence: list, audio_verify: dict) -> dict:
    """Execute L3: red team; only corroborated falsification blocks."""
    l3 = ag1.red_team(samples, evidence, audio_verify)
    blocking = {sid: out for sid, out in l3.items() if g1r.corroborated_l3(out)}
    advisory = {sid: out for sid, out in l3.items()
                if out.get("falsified") and sid not in blocking}
    return {"blocking": blocking, "advisory": advisory,
            "falsified": blocking, "pass": not blocking}


def arbitrate_disagreements(samples: list, disagreements: list, evidence: list) -> dict:
    """Execute arbitration; a missing arbiter score is itself unresolved."""
    by_id = {s["id"]: s for s in samples}
    items, unresolved = [], []
    for d in disagreements:
        sample = by_id[d["sample"]]
        prompt = (ag1.judge_prompt(sample, "Coach X", hear=False)
                  + f"\n\nOther judges scored {d['dim']} as {d['scores']}. "
                    f"Independent score for {d['dim']} only. JSON: {{\"score\":N}}")
        out = ag1.call_model(ag1.ARBITER, [{"role": "user", "content": prompt}])
        score = out.get("score") if isinstance(out, dict) else None
        if isinstance(out, dict) and isinstance(out.get("scores"), dict):
            nested = out["scores"].get(d["dim"])
            if isinstance(nested, (int, float)):
                score = nested
        evidence.append({"layer": "arbitration", "judge": ag1.ARBITER,
                         "sample": d["sample"], "dim": d["dim"],
                         "prompt": prompt, "output": out})
        item = {**d, "arbiter": score}
        items.append(item)
        if not isinstance(score, (int, float)):
            unresolved.append({**item, "reason": "arbiter_no_score"})
        elif max(d["scores"] + [score]) - min(d["scores"] + [score]) > 1.0:
            unresolved.append({**item, "reason": "spread_gt_1"})
    return {"items": items, "unresolved": unresolved, "count": len(items)}


def _model_set(model_ids: dict) -> list[str]:
    models: set[str] = set()
    for value in model_ids.values():
        if isinstance(value, (list, tuple, set)):
            models.update(str(v) for v in value)
        else:
            models.add(str(value))
    return sorted(models)


def preflight_models(model_ids: dict) -> dict:
    models = _model_set(model_ids)
    errors, ok_models = {}, []
    for model in models:
        try:
            out = ag1.call_model(model, [{"role": "user",
                                          "content": "Return JSON: {\"ok\":true}"}],
                                 timeout=60)
            if not isinstance(out, dict):
                raise RuntimeError("non-object response")
            ok_models.append(model)
        except Exception as exc:  # noqa: BLE001 - fail closed, stop the run
            errors[model] = str(exc)[:180]
    return {"ok": not errors, "models": models, "ok_models": ok_models,
            "errors": errors}


def regenerate_samples(samples: list, audio_dir: Path, model) -> tuple[list, list]:
    """3-attempt regeneration; excluded samples are disclosed, never silent."""
    kept, excluded = [], []
    for sample in samples:
        fresh = None
        for attempt in range(3):
            try:
                fresh = g1r.regenerate_grounded(sample, audio_dir, model, 12)
                break
            except Exception as exc:  # noqa: BLE001 - validator/transport failure
                if attempt == 2:
                    excluded.append({"id": sample["id"], "error": str(exc)[:160]})
        if fresh:
            sample.update(fresh)
            kept.append(sample)
    return kept, excluded


# --------------------------------------------------------------- G1 decision
@dataclass(frozen=True)
class ProtocolResult:
    """Computed layer results. ``decide`` inputs can only come from here."""
    missing: bool
    l0_pass: bool
    anchor_full: bool
    l1_pass: bool
    l3_pass: bool
    escalate: bool
    underpowered: bool

    def decide_inputs(self) -> dict:
        return {
            "missing": self.missing,
            "l0_pass": self.l0_pass,
            "anchor_full": self.anchor_full,
            "l1_pass": self.l1_pass,
            "l3_pass": self.l3_pass,
            "escalate": self.escalate,
            "underpowered": self.underpowered,
        }


def compose_verdict(result: ProtocolResult) -> tuple:
    """Single call site: every input is a computed ProtocolResult field."""
    return g1r.decide(**result.decide_inputs())


def execute_g1(samples: list, audio_dir: Path, *, prereg_sha: str | None,
               model_ids: dict, truth: dict | None = None,
               evidence: list | None = None,
               preflight_fn=None, regenerate_fn=None, l0_fn=None,
               l1_fn=None, l3_fn=None, arbitration_fn=None) -> dict:
    """Execute the preregistered G1 protocol with no hard-coded layer inputs."""
    evidence = evidence if evidence is not None else []
    preflight = (preflight_fn or preflight_models)(model_ids)
    if not preflight.get("ok"):
        return {"error": "model_preflight_failed", "preflight": preflight,
                "evidence": evidence}

    if regenerate_fn is None:
        model = QwenAdapter(api_key=os.environ["DASHSCOPE_API_KEY"])
        kept, excluded = regenerate_samples(samples, audio_dir, model)
    else:
        kept, excluded = regenerate_fn(samples, audio_dir, None)
    if not kept:
        return {"error": "no_samples_after_regeneration", "excluded": excluded,
                "evidence": evidence}

    l0 = (l0_fn or evaluate_l0)(kept, audio_dir, truth or {})
    l1 = (l1_fn or evaluate_l1)(kept, audio_dir, evidence)
    l3 = (l3_fn or evaluate_l3)(kept, evidence, l1.get("audio_verify", {}))
    arb = (arbitration_fn or arbitrate_disagreements)(
        kept, l1.get("disagreements", []), evidence)

    result = ProtocolResult(
        missing=False,
        l0_pass=bool(l0["pass"]),
        anchor_full=l0["anchor_coverage"] == "full",
        l1_pass=bool(l1["pass"]),
        l3_pass=bool(l3["pass"]),
        escalate=bool(arb["unresolved"]),
        underpowered=len(kept) < g1r.UNDERPOWERED_N,
    )
    verdict, label = compose_verdict(result)
    return {"result": result, "verdict": verdict, "label": label,
            "kept": kept, "excluded": excluded, "l0": l0, "l1": l1, "l3": l3,
            "arbitration": arb, "preflight": preflight, "evidence": evidence}


def build_g1_report(run: dict, *, prereg_sha: str | None, model_ids: dict,
                    dropped_duplicate: list, corpus_label: str,
                    call_stats: dict) -> dict:
    l0, l1, l3, arb = run["l0"], run["l1"], run["l3"], run["arbitration"]
    result: ProtocolResult = run["result"]
    return {
        "protocol": "G1-R-fullprotocol",
        "seed": SEED,
        "evaluated_at_utc": now_utc(),
        "verdict": run["verdict"],
        "gate1_label": run["label"],
        "claim_scope": (
            "cross-family machine blind text panel + objective anchors; NOT a "
            "human-annotated or human-blind gate; owner is final escalation only; "
            "audio layer is same-family and evidence-only (never PASS-bearing)"
        ),
        "human_annotators": 0,
        "owner_anchor": False,
        "prereg": {"doc_sha256": prereg_sha},
        "model_ids": model_ids,
        "corpus": corpus_label,
        "corpus_license": "L2-ARCTIC, CC BY-NC, local evaluation only, not redistributed",
        "anchor_coverage": l0["anchor_coverage"],
        "anchor_set": l0["anchor_set"],
        "anchor_out_of_scope": l0["anchor_out_of_scope"],
        "dropped_duplicate": dropped_duplicate,
        "n_input": len(run.get("input_ids", [])),
        "n_evaluated": len(run["kept"]),
        "evaluated_ids": [s["id"] for s in run["kept"]],
        "excluded_regeneration": run["excluded"],
        "model_preflight": run["preflight"],
        "L0": {"pass": l0["pass"], "issues": l0["issues"],
               "records": l0["records"], "anchor_coverage": l0["anchor_coverage"],
               "calibrated_prosody_backing": l0["calibrated_prosody_backing"]},
        "L1": {
            "sample_means": l1["sample_means"],
            "overall_mean": l1["overall_mean"],
            "overall_mean_ci": l1["overall_mean_ci"],
            "text_only_mean": l1["text_only_mean"],
            "audio_only_mean": l1["audio_only_mean"],
            "reliability": l1["reliability"],
            "reliability_ok": l1["reliability_ok"],
            "critical_majority": l1["critical_majority_count"],
            "critical_majority_count": l1["critical_majority_count"],
            "audio_criticals": l1["audio_criticals"],
            "audio_scope_violations": l1["audio_scope_violations"],
            "audio_layer_cross_family": False,
            "pass": l1["pass"],
        },
        "L2": {"descriptive": True, "work_baseline_available": False,
               "reason": "no Work historical baseline is used in this corpus run",
               "pass": None},
        "L3": {"falsified": l3["falsified"], "advisory": l3["advisory"],
               "pass": l3["pass"]},
        "L4": {"owner_anchor": False, "contradictions": []},
        "disagreements": l1["disagreements"],
        "arbitration": arb["items"],
        "unresolved": arb["unresolved"],
        "escalate": result.escalate,
        "underpowered": result.underpowered,
        "cost": call_stats,
    }


# --------------------------------------------------------------- commands
def write_error_report(out: Path, *, protocol: str, prereg_sha: str | None,
                       error: str, detail=None, evidence=None,
                       model_ids=None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    report = {"protocol": protocol, "seed": SEED, "evaluated_at_utc": now_utc(),
              "verdict": "ERROR", "error": error, "detail": detail,
              "prereg": {"doc_sha256": prereg_sha}, "model_ids": model_ids,
              "note": "fail-closed; no PASS is written for a missing/blocked input"}
    write_json(out / "report.json", report)
    write_json(out / "raw-evidence.json", evidence or [])
    seal_dir(out)


def run_g2_command(out: Path, *, prereg_sha: str | None, max_speakers: int,
                   pause_mode: str = "vad", split: str = "validate") -> int:
    if pause_mode not in DETECTOR_MODES:
        write_error_report(out, protocol="G2-prosody-robustness",
                           prereg_sha=prereg_sha,
                           error=f"invalid pause_mode: {pause_mode}")
        print("G2 ERROR: invalid pause_mode", pause_mode)
        return 3
    try:
        samples = load_corpus(max_speakers)
    except EvalError as exc:
        write_error_report(out, protocol="G2-prosody-robustness",
                           prereg_sha=prereg_sha, error=str(exc))
        print("G2 ERROR:", exc)
        return 3
    half = len(samples) // 2
    tune, validate = samples[:half], samples[half:]
    if split not in {"validate", "tune"}:
        write_error_report(out, protocol="G2-prosody-robustness",
                           prereg_sha=prereg_sha,
                           error=f"invalid split: {split}")
        print("G2 ERROR: invalid split", split)
        return 3
    evaluated = validate if split == "validate" else tune
    if split == "tune":
        print("WARNING: tune split evaluation is exploratory, not a gate verdict")
    try:
        summary, raw_checks = g2_prosody_retest(evaluated, pause_mode=pause_mode)
    except EvalError as exc:
        write_error_report(out, protocol="G2-prosody-robustness",
                           prereg_sha=prereg_sha, error=str(exc))
        print("G2 ERROR:", exc)
        return 3
    params = detector_parameters(pause_mode)
    exploratory = split == "tune"
    report = {
        "protocol": "G2-prosody-robustness",
        "seed": SEED,
        "evaluated_at_utc": now_utc(),
        "verdict": ("INVALID" if summary.get("invalid")
                    else "EXPLORATORY" if exploratory
                    else ("PASS" if summary["pass"] else "FAIL")),
        "exploratory_split": exploratory,
        "gate_eligible": not exploratory,
        "invalid": summary.get("invalid", False),
        "invalid_reason": summary.get("invalid_reason"),
        "zero_pause_rows": summary.get("zero_pause_rows"),
        "corpus": "L2-ARCTIC (CC BY-NC, eval only)",
        "corpus_license": "CC BY-NC, local evaluation only, not redistributed",
        "prereg": {"doc_sha256": prereg_sha},
        "mode": pause_mode,
        "conditions": summary["conditions"],
        "primary_conditions": summary["primary_conditions"],
        "n_speakers": len(evaluated),
        "split": {"rule": "sorted 22 speakers; first 11 tune / last 11 validate",
                  "evaluated": split,
                  "tune": [s["id"] for s in tune],
                  "validate": [s["id"] for s in validate],
                  "evaluated_ids": [s["id"] for s in evaluated]},
        "detector": params,
        "retest_consistency": summary["retest_consistency"],
        "threshold": summary["threshold"],
        "pass": None if exploratory else summary["pass"],
        "exploratory_retest_consistency": (
            summary["retest_consistency"] if exploratory else None),
        "n_rows": summary["n_rows"],
        "n_primary_checks": summary["n_primary_checks"],
        "n_primary_ok": summary["n_primary_ok"],
        "by_condition": summary["by_condition"],
        "original_excluded_from_primary": summary["original_excluded_from_primary"],
        "original_reason": summary["original_reason"],
        "descriptive": summary["descriptive"],
        "duration_metric": summary["duration_metric"],
        "human_annotation_subset": "not provided (retest-only; disclosed)",
        "human_pause_annotation": "not provided (retest-only; disclosed)",
        "training_overlap": "unknown (declared)",
        "phoneme": "OFF / out-of-scope (reported as part of the single G2 verdict)",
        "rows": summary["rows"],
        "raw_evidence": "raw-evidence.json",
    }
    write_json(out / "report.json", report)
    write_json(out / "raw-evidence.json",
               {"protocol": "G2-prosody-robustness", "seed": SEED,
                "generated_at_utc": now_utc(), "mode": pause_mode,
                "prereg_sha256": prereg_sha,
                "detector": params,
                "checks": raw_checks})
    seal_dir(out)
    print("G2 verdict:", report["verdict"], "retest:", summary["retest_consistency"],
          "zero_pause_rows:", summary.get("zero_pause_rows"),
          "by_condition:", {k: v["consistency"] for k, v in summary["by_condition"].items()})
    if report["verdict"] in {"PASS", "EXPLORATORY"}:
        return 0
    return 2 if report["verdict"] == "FAIL" else 3


def run_g1_command(out: Path, *, prereg_sha: str | None, max_speakers: int,
                   truth_path: str | None) -> int:
    if not os.environ.get("DASHSCOPE_API_KEY"):
        write_error_report(out, protocol="G1-R-fullprotocol",
                           prereg_sha=prereg_sha, error="missing_api_key",
                           detail="DASHSCOPE_API_KEY is not set; fail-closed")
        print("G1 ERROR: missing_api_key")
        return 3
    try:
        samples = load_corpus(max_speakers)
    except EvalError as exc:
        write_error_report(out, protocol="G1-R-fullprotocol",
                           prereg_sha=prereg_sha, error=str(exc))
        print("G1 ERROR:", exc)
        return 3

    hashes = {s["audio_file"]: sha256_file(CORPUS / "wav" / s["audio_file"])
              for s in samples}
    kept_input, dropped = g1r.dedup_samples(samples, hashes)
    truth = json.loads(Path(truth_path).read_text()) if truth_path else {}

    model_ids = dict(g1r.MODEL_IDS)
    # Freeze the shipped coach id explicitly (QwenAdapter default text model).
    from runner.models.qwen import DEFAULT_TEXT_MODEL
    model_ids["coach"] = DEFAULT_TEXT_MODEL

    evidence: list = []
    call_meta: dict[int, tuple] = {}  # id -> (output_ref, meta); ref pins the id
    counts: dict[str, int] = {}
    lock = threading.Lock()
    original_call = ag1.call_model

    def counted(model, messages, **kwargs):
        started = now_utc()
        out = original_call(model, messages, **kwargs)
        finished = now_utc()
        meta = {"model": model, "started_at_utc": started,
                "finished_at_utc": finished,
                "request_sha256": canonical_sha256(messages),
                "response_sha256": canonical_sha256(out)}
        with lock:
            counts[model] = counts.get(model, 0) + 1
            call_meta[id(out)] = (out, meta)
        return out

    ag1.call_model = counted
    try:
        run = execute_g1(kept_input, CORPUS / "wav", prereg_sha=prereg_sha,
                         model_ids=model_ids, truth=truth, evidence=evidence)
    except Exception as exc:  # noqa: BLE001 - fail-closed stop, no retry
        ag1.call_model = original_call
        enrich_evidence(evidence, call_meta)
        stats = {"api_calls": sum(counts.values()), "by_model": dict(counts),
                 "budget_cap_cny": 100,
                 "note": "estimated spend only; DashScope usage is not retained "
                         "by the sealed helper. Hard cap ¥100 enforced by scope "
                         "(<=~200 calls)."}
        write_error_report(out, protocol="G1-R-fullprotocol",
                           prereg_sha=prereg_sha,
                           error="run_aborted", detail=str(exc)[:400],
                           evidence={"calls": evidence, "cost": stats},
                           model_ids=model_ids)
        print("G1 ERROR: run aborted:", str(exc)[:200])
        return 3
    finally:
        ag1.call_model = original_call

    enrich_evidence(evidence, call_meta)
    coach_calls = len(kept_input)
    stats = {"api_calls": sum(counts.values()), "by_model": dict(counts),
             "coach_regeneration_calls": coach_calls,
             "budget_cap_cny": 100,
             "estimated_cny_upper_bound": round(
                 (sum(counts.values()) + coach_calls) * 0.25, 2),
             "note": "estimated spend only (conservative per-call upper bound); "
                     "DashScope usage is not retained by the sealed helper; "
                     "hard cap ¥100 enforced by call scope."}

    if "error" in run:
        write_error_report(out, protocol="G1-R-fullprotocol",
                           prereg_sha=prereg_sha, error=run["error"],
                           detail=run.get("preflight") or run.get("excluded"),
                           evidence={"calls": evidence, "cost": stats},
                           model_ids=model_ids)
        print("G1 ERROR:", run["error"])
        return 3

    run["input_ids"] = [s["id"] for s in kept_input]
    report = build_g1_report(run, prereg_sha=prereg_sha, model_ids=model_ids,
                             dropped_duplicate=dropped,
                             corpus_label="L2-ARCTIC (CC BY-NC, eval only)",
                             call_stats=stats)
    write_json(out / "report.json", report)
    write_json(out / "raw-evidence.json",
               {"protocol": "G1-R-fullprotocol", "seed": SEED,
                "generated_at_utc": now_utc(),
                "prereg": {"doc_sha256": prereg_sha},
                "model_ids": model_ids,
                "calls": evidence, "cost": stats})
    seal_dir(out)
    print("=== G1-R FULL PROTOCOL VERDICT:", report["verdict"], "===")
    print("label:", report["gate1_label"], "| anchor:", report["anchor_coverage"],
          "| underpowered:", report["underpowered"])
    print("L0:", report["L0"]["pass"], "| L1 mean:", report["L1"]["overall_mean"],
          report["L1"]["overall_mean_ci"], "crit-majority:",
          report["L1"]["critical_majority"], "within1:",
          report["L1"]["reliability"]["within1_fraction"], "pass:",
          report["L1"]["pass"])
    print("L3 blocking:", list(report["L3"]["falsified"]),
          "advisory:", list(report["L3"]["advisory"]), "pass:", report["L3"]["pass"])
    print("unresolved:", len(report["unresolved"]), "| api_calls:",
          stats["api_calls"])
    return 0 if report["verdict"] == "PASS" else 2


def enrich_evidence(evidence: list, call_meta: dict[int, tuple]) -> None:
    for entry in evidence:
        out = entry.get("output")
        record = call_meta.get(id(out))
        if record and record[0] is out:
            meta = record[1]
            entry["recorded_at_utc"] = meta["finished_at_utc"]
            entry["request_sha256"] = meta["request_sha256"]
            entry["response_sha256"] = meta["response_sha256"]
            entry["responder_model"] = meta["model"]


def main() -> int:
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--g2-only", action="store_true")
    group.add_argument("--g1-only", action="store_true")
    group.add_argument("--calibration-only", action="store_true")
    ap.add_argument("--vad", action="store_true",
                    help="legacy alias for --pause-mode vad")
    ap.add_argument("--pause-mode", choices=DETECTOR_MODES, default=None,
                    help="G2 detector under test (frozen prereg)")
    ap.add_argument("--split", choices=("validate", "tune"), default="validate",
                    help="G2 split; validate (held-out) is the gate")
    ap.add_argument("--out", required=True)
    ap.add_argument("--prereg", default=None, help="frozen preregistration doc")
    ap.add_argument("--truth", default=None, help="optional HJK-style truth JSON")
    ap.add_argument("--max-speakers", type=int, default=EXPECTED_SPEAKERS)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prereg_sha = load_prereg_sha(args.prereg)

    if args.vad and args.pause_mode and args.pause_mode != "vad":
        write_error_report(out, protocol="G2-prosody-robustness",
                           prereg_sha=prereg_sha,
                           error="--vad conflicts with --pause-mode")
        print("G2 ERROR: --vad conflicts with --pause-mode")
        return 3
    pause_mode = "vad" if args.vad else args.pause_mode

    if args.calibration_only:
        if not pause_mode:
            write_error_report(out, protocol="G2-prosody-calibration",
                               prereg_sha=prereg_sha,
                               error="--calibration-only requires --pause-mode")
            print("CALIBRATION ERROR: --calibration-only requires --pause-mode")
            return 3
        return run_calibration_command(out, prereg_sha=prereg_sha,
                                       pause_mode=pause_mode)
    if args.g2_only:
        if not pause_mode:
            write_error_report(out, protocol="G2-prosody-robustness",
                               prereg_sha=prereg_sha,
                               error="--g2-only requires --pause-mode "
                                     "(or --vad)")
            print("G2 ERROR: --g2-only requires --pause-mode (or --vad)")
            return 3
        return run_g2_command(out, prereg_sha=prereg_sha,
                              max_speakers=args.max_speakers,
                              pause_mode=pause_mode, split=args.split)
    if args.g1_only:
        return run_g1_command(out, prereg_sha=prereg_sha,
                              max_speakers=args.max_speakers,
                              truth_path=args.truth)
    # Legacy combined mode is intentionally not used for the single-run cycle.
    write_error_report(out, protocol="G1G2-rev3", prereg_sha=prereg_sha,
                       error="choose_exactly_one_mode",
                       detail="use --g2-only --vad or --g1-only; the combined "
                              "mode would re-run a single-run protocol")
    print("ERROR: choose --g2-only --vad or --g1-only")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())