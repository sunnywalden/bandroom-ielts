#!/usr/bin/env python3
"""G2 robustness research lab (tune phase only; never used for held-out).

Builds a byte-identical condition cache (using ``run_eval.degrade_audio``) and
evaluates candidate DSP-hardening pause detectors on the *tune* split
(sorted 22 speakers, first 11).  The held-out split is intentionally not
accepted by the robustness entry point here: held-out validation must run once
through the frozen harness.

Usage:
  python3 g2_tune_lab.py cache
  python3 g2_tune_lab.py eval --detector baseline
  python3 g2_tune_lab.py grid            # documented parameter sweep
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import butter, sosfiltfilt

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

import run_eval as re_  # noqa: E402
from runner import grounded_audio as ga  # noqa: E402
from runner import prosody  # noqa: E402

# Portable cache location: override with BANDROOM_G2_TUNE_CACHE, else default
# to the acceptance tune-log under the project root (the parent of this repo).
# No operator-specific absolute path is baked into tracked source.
CACHE = Path(
    os.environ.get(
        "BANDROOM_G2_TUNE_CACHE",
        str(
            REPO.parent
            / "acceptance-2026-11-10"
            / "iteration-29"
            / "g2-robustness"
            / "tune-log"
            / "audio-cache"
        ),
    )
)
CONDITIONS = re_.G2_CONDITIONS
PRIMARY = re_.G2_PRIMARY_CONDITIONS


# --------------------------------------------------------------- cache
def speaker_ids() -> list[str]:
    return [s["id"] for s in re_.load_corpus()]


def build_cache() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    for s in re_.load_corpus():
        out = CACHE / s["id"]
        if (out / "original.wav").exists() and all(
            (out / f"{c}.wav").exists() for c in CONDITIONS
        ):
            print(f"cached {s['id']}", flush=True)
            continue
        out.mkdir(parents=True, exist_ok=True)
        raw = (re_.CORPUS / "wav" / s["audio_file"]).read_bytes()
        with re_.tempfile.TemporaryDirectory() as wd:
            wd = Path(wd)
            _, orig = ga.decode_to_wav(raw, wd)
            (out / "original.wav").write_bytes(Path(orig).read_bytes())
            for cond in CONDITIONS:
                if cond == "original":
                    continue
                deg, _ = re_.degrade_audio(cond, Path(orig), wd)
                (out / f"{cond}.wav").write_bytes(Path(deg).read_bytes())
        print(f"built {s['id']}", flush=True)


# --------------------------------------------------------------- candidate DSP
def _filter(samples: np.ndarray, sr: int, highpass: float | None,
            lowpass: float | None) -> np.ndarray:
    if highpass is None and lowpass is None:
        return samples
    nyq = sr / 2.0
    if highpass is not None and lowpass is not None:
        sos = butter(4, [highpass / nyq, lowpass / nyq], btype="bandpass", output="sos")
    elif highpass is not None:
        sos = butter(4, highpass / nyq, btype="highpass", output="sos")
    else:
        sos = butter(4, lowpass / nyq, btype="lowpass", output="sos")
    return sosfiltfilt(sos, samples)


def robust_pauses(
    samples: np.ndarray,
    sr: int = 16000,
    *,
    highpass: float | None = None,
    lowpass: float | None = None,
    frame_s: float = 0.025,
    hop_s: float = 0.010,
    noise_pct: float = 10.0,
    noise_cap: float = 0.25,
    smooth_frames: int = 1,
    smooth_kind: str = "median",
    excess: bool = True,
    low_mult: float = 1.25,
    high_mult: float = 2.83,
    bridge_s: float = 0.10,
    bridge_mult: float = 2.5,
    min_pause_s: float = 0.32,
    refine: bool = False,
    abs_floor: float = 0.0005,
    abs_high_floor: float = 0.0008,
) -> prosody.PauseDetection:
    """Parametrised noise-relative detector used for tuning experiments.

    ``excess=True`` subtracts the estimated noise *power* from the frame
    power before thresholding, so additive stationary noise does not inflate
    pause durations.  Multipliers are then expressed relative to the noise RMS.
    ``excess=False`` reproduces the shipped detector's total-RMS thresholds
    (low=1.6, high=3.0 in the shipped constants).
    """
    x = _filter(np.asarray(samples, dtype=np.float64), sr, highpass, lowpass)
    energy = prosody.frame_energy(x, sr, frame_seconds=frame_s, hop_seconds=hop_s)
    power = energy.rms.astype(np.float64) ** 2
    if smooth_frames > 1:
        if smooth_kind == "median":
            power = median_filter(power, size=smooth_frames, mode="nearest")
        else:
            power = uniform_filter1d(power, size=smooth_frames, mode="nearest")
    rms = np.sqrt(np.maximum(power, 0.0))
    p_noise = float(np.percentile(power, noise_pct))
    p90 = float(np.percentile(power, 90.0))
    p_noise = min(p_noise, p90 * noise_cap)
    noise_rms = float(np.sqrt(max(p_noise, 0.0)))
    if excess:
        excess_rms = np.sqrt(np.maximum(power - p_noise, 0.0))
    else:
        excess_rms = rms
    low = max(abs_floor, noise_rms * low_mult)
    high = max(abs_high_floor, noise_rms * high_mult, low * 1.25)
    # For legacy-compatible (excess=False) semantics, thresholds are total RMS.
    if not excess:
        low = max(abs_floor, float(np.sqrt(p_noise)) * low_mult)
        high = max(abs_high_floor, float(np.sqrt(p_noise)) * high_mult, low * 1.25)

    segments: list[list[int]] = []
    in_silence = False
    start = 0
    for i, v in enumerate(excess_rms):
        if not in_silence and v < low:
            in_silence = True
            start = i
        elif in_silence and v > high:
            in_silence = False
            segments.append([start, i])
    if in_silence:
        segments.append([start, len(excess_rms)])

    merged: list[list[int]] = []
    for a, b in segments:
        if merged:
            pa, pb = merged[-1]
            gap_s = (a - pb) * energy.frame_seconds
            between = excess_rms[pb:min(a + 1, len(excess_rms))]
            if gap_s <= bridge_s and (
                len(between) == 0 or float(np.median(between)) < noise_rms * bridge_mult
            ):
                merged[-1] = [pa, b]
                continue
        merged.append([a, b])

    tops = np.flatnonzero(excess_rms > high)
    total = len(x) / float(sr)
    if len(tops):
        span = (float(energy.times[tops[0]]), min(total, float(energy.times[tops[-1]] + energy.frame_seconds)))
    else:
        span = (0.0, total)
    pauses = []
    if len(tops):
        for a, b in merged:
            begin = float(energy.times[a])
            finish = float(energy.times[b]) if b < len(energy.times) else float(total)
            if refine:
                begin = _cross(excess_rms, energy.times, a - 1, a, low, begin)
                finish = _cross(excess_rms, energy.times, b - 1, b, high, finish)
            begin = max(begin, span[0])
            finish = min(finish, span[1])
            if finish - begin >= min_pause_s - 1e-9:
                pauses.append({"start": round(begin, 4), "end": round(finish, 4),
                               "seconds": round(finish - begin, 4)})
    pauses.sort(key=lambda p: p["start"])
    pause_seconds = sum(p["seconds"] for p in pauses)
    speech_seconds = max(0.0, (span[1] - span[0]) - pause_seconds)
    return prosody.PauseDetection(
        pauses=pauses, noise_floor_rms=round(noise_rms, 6),
        low_threshold_rms=round(low, 6), high_threshold_rms=round(high, 6),
        speech_span=(round(span[0], 4), round(span[1], 4)),
        speech_seconds=speech_seconds, total_seconds=total)


def _stft_power(samples: np.ndarray, sr: int, frame_s: float, hop_s: float):
    frame = int(round(frame_s * sr))
    hop = int(round(hop_s * sr))
    if len(samples) < frame:
        samples = np.pad(samples, (0, frame - len(samples)))
    count = 1 + (len(samples) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    frames = samples[idx]
    window = np.hanning(frame)
    spec = np.fft.rfft(frames * window, axis=1)
    power = np.abs(spec) ** 2
    times = (np.arange(count) * hop) / float(sr)
    return power, times, frame / float(sr)


def _segments_from_envelope(values, times, low, high, frame_s, bridge_s,
                            bridge_level, min_pause_s, span_mode="high",
                            min_speech_s: float = 0.0):
    segments = []
    in_silence = False
    start = 0
    for i, v in enumerate(values):
        if not in_silence and v < low:
            in_silence = True
            start = i
        elif in_silence and v > high:
            in_silence = False
            segments.append([start, i])
    if in_silence:
        segments.append([start, len(values)])
    merged = []
    for a, b in segments:
        if merged:
            pa, pb = merged[-1]
            gap_s = (a - pb) * frame_s
            between = values[pb:min(a + 1, len(values))]
            if (gap_s <= bridge_s and (
                len(between) == 0 or float(np.median(between)) < bridge_level
            )) or (min_speech_s > 0 and gap_s <= min_speech_s):
                merged[-1] = [pa, b]
                continue
        merged.append([a, b])
    tops = np.flatnonzero(values > high)
    total = float(times[-1] + frame_s) if len(times) else 0.0
    if len(tops):
        span = (float(times[tops[0]]), min(total, float(times[tops[-1]] + frame_s)))
    else:
        span = (0.0, total)
    pauses = []
    if len(tops):
        for a, b in merged:
            begin = float(times[a])
            finish = float(times[b]) if b < len(times) else total
            begin = max(begin, span[0])
            finish = min(finish, span[1])
            if finish - begin >= min_pause_s - 1e-9:
                pauses.append({"start": round(begin, 4), "end": round(finish, 4),
                               "seconds": round(finish - begin, 4)})
    pauses.sort(key=lambda p: p["start"])
    pause_seconds = sum(p["seconds"] for p in pauses)
    return pauses, span, max(0.0, (span[1] - span[0]) - pause_seconds), total


def spectral_pauses(
    samples: np.ndarray,
    sr: int = 16000,
    *,
    highpass: float | None = None,
    frame_s: float = 0.025,
    hop_s: float = 0.010,
    noise_pct: float = 10.0,
    beta: float = 1.5,
    wiener: bool = False,
    level_pct: float = 90.0,
    low_frac: float = 0.05,
    high_frac: float = 0.10,
    smooth_frames: int = 3,
    smooth_kind: str = "box",
    bridge_s: float = 0.10,
    bridge_frac: float = 0.5,
    min_speech_s: float = 0.0,
    noise_freq_smooth: int = 0,
    energy_freq_smooth: int = 0,
    noise_running_s: float = 0.0,
    min_pause_s: float = 0.32,
) -> prosody.PauseDetection:
    """Spectral-subtraction energy VAD (noise PSD from quiet frames)."""
    x = _filter(np.asarray(samples, dtype=np.float64), sr, highpass, None)
    power, times, frame_seconds = _stft_power(x, sr, frame_s, hop_s)
    noise_psd = np.percentile(power, noise_pct, axis=0)
    if noise_freq_smooth >= 3:
        noise_psd = median_filter(noise_psd, size=noise_freq_smooth, mode="nearest")
    if noise_running_s > 0:
        block = max(1, int(round(noise_running_s / frame_seconds)))
        running = np.empty_like(power)
        for start in range(0, power.shape[0], block):
            end = min(start + block, power.shape[0])
            running[start:end] = np.percentile(power[start:end], noise_pct, axis=0)
        noise_psd = np.minimum(noise_psd, running)
    if wiener:
        clean = power * np.maximum(1.0 - beta * noise_psd / np.maximum(power, 1e-12), 0.0)
    else:
        clean = np.maximum(power - beta * noise_psd, 0.0)
    if energy_freq_smooth >= 3:
        clean = uniform_filter1d(clean, size=energy_freq_smooth, axis=1, mode="nearest")
    energy = clean.mean(axis=1)
    if smooth_frames > 1:
        if smooth_kind == "median":
            energy = median_filter(energy, size=smooth_frames, mode="nearest")
        else:
            energy = uniform_filter1d(energy, size=smooth_frames, mode="nearest")
    level = float(np.percentile(energy, level_pct))
    low = max(1e-12, level * low_frac)
    high = max(low * 1.05, level * high_frac)
    pauses, span, speech_seconds, total = _segments_from_envelope(
        energy, times, low, high, frame_seconds, bridge_s,
        level * bridge_frac, min_pause_s, min_speech_s=min_speech_s)
    return prosody.PauseDetection(
        pauses=pauses, noise_floor_rms=round(float(np.sqrt(max(np.mean(noise_psd), 0))), 6),
        low_threshold_rms=round(float(np.sqrt(low)), 6),
        high_threshold_rms=round(float(np.sqrt(high)), 6),
        speech_span=(round(span[0], 4), round(span[1], 4)),
        speech_seconds=speech_seconds, total_seconds=total)


def harmonicity_pauses(
    samples: np.ndarray,
    sr: int = 16000,
    *,
    frame_s: float = 0.040,
    hop_s: float = 0.010,
    smooth_frames: int = 5,
    low_frac: float = 0.25,
    high_frac: float = 0.40,
    energy_pct: float = 90.0,
    energy_frac: float = 0.02,
    bridge_s: float = 0.12,
    min_pause_s: float = 0.32,
) -> prosody.PauseDetection:
    """Speech = frame is periodic in the 60-400 Hz lag range AND has energy.

    Silence/noise frames are poorly periodic.  The harmonicity envelope is
    smoothed; pauses are non-speech runs.
    """
    x = np.asarray(samples, dtype=np.float64)
    frame = int(round(frame_s * sr))
    hop = int(round(hop_s * sr))
    if len(x) < frame:
        x = np.pad(x, (0, frame - len(x)))
    lag_lo = int(sr / 400)
    lag_hi = int(sr / 60)
    count = 1 + (len(x) - frame) // hop
    harmonic = np.zeros(count, dtype=np.float64)
    rms = np.zeros(count, dtype=np.float64)
    for i in range(count):
        seg = x[i * hop:i * hop + frame]
        seg = seg - float(np.mean(seg))
        denom = float(np.dot(seg, seg))
        rms[i] = float(np.sqrt(denom / frame))
        if denom <= 1e-20:
            continue
        ac = np.correlate(seg, seg, mode="full")[frame - 1:]
        window = ac[lag_lo:lag_hi]
        if len(window):
            harmonic[i] = float(np.max(window)) / denom
    if smooth_frames > 1:
        harmonic = uniform_filter1d(harmonic, size=smooth_frames, mode="nearest")
        rms = uniform_filter1d(rms, size=smooth_frames, mode="nearest")
    level = float(np.percentile(rms, energy_pct))
    voiced = (harmonic >= low_frac) & (rms >= level * energy_frac)
    # Envelope for generic segmentation: 1 when voiced, 0 otherwise.
    env = voiced.astype(np.float64)
    times = (np.arange(count) * hop) / float(sr)
    # Reuse the silence-run helper with inverted logic by building a
    # speech-run pass directly.
    speech_runs = []
    start = None
    for i, v in enumerate(voiced):
        if v and start is None:
            start = i
        elif not v and start is not None:
            speech_runs.append([start, i])
            start = None
    if start is not None:
        speech_runs.append([start, count])
    total = len(x) / float(sr)
    # Bridge short unvoiced gaps between speech runs; require >=0.12 s.
    merged = []
    for a, b in speech_runs:
        if merged and (a - merged[-1][1]) * hop / sr <= bridge_s:
            merged[-1] = [merged[-1][0], b]
        else:
            merged.append([a, b])
    pauses = []
    span = ((merged[0][0] * hop / sr, merged[-1][1] * hop / sr)
            if merged else (0.0, total))
    for a, b in zip(merged, merged[1:]):
        begin, finish = a[1] * hop / sr, b[0] * hop / sr
        if finish - begin >= min_pause_s - 1e-9:
            pauses.append({"start": round(begin, 4), "end": round(finish, 4),
                           "seconds": round(finish - begin, 4)})
    pause_seconds = sum(p["seconds"] for p in pauses)
    return prosody.PauseDetection(
        pauses=pauses, noise_floor_rms=0.0, low_threshold_rms=low_frac,
        high_threshold_rms=high_frac,
        speech_span=(round(span[0], 4), round(span[1], 4)),
        speech_seconds=max(0.0, (span[1] - span[0]) - pause_seconds),
        total_seconds=total)


def _cross(values: np.ndarray, times: np.ndarray, i: int, j: int,
           level: float, fallback: float) -> float:
    if i < 0 or j >= len(values):
        return fallback
    a, b = float(values[i]), float(values[j])
    if a == b:
        return float(times[j])
    frac = (a - level) / (a - b)
    frac = min(max(frac, 0.0), 1.0)
    return float(times[i] + frac * (times[j] - times[i]))


def detector(mode: str, **kw):
    if mode == "baseline":
        return lambda p: prosody.detect_pauses(prosody.load_wav(p).samples)
    if mode in {"candidate", "spectral", "harmonic"}:
        fn = {"candidate": robust_pauses, "spectral": spectral_pauses,
              "harmonic": harmonicity_pauses}[mode]

        def run(p):
            a = prosody.load_wav(p)
            return fn(a.samples, a.sample_rate, **kw)
        return run
    raise ValueError(mode)


# --------------------------------------------------------------- eval
def metrics_for(path_orig: Path, path_deg: Path, detect) -> dict:
    base = detect(path_orig)
    deg = detect(path_deg)
    pc_match = base.pause_count == deg.pause_count
    o = base.pause_seconds
    d = deg.pause_seconds
    pde = None if o <= 0 else abs(o - d) / o
    iou = re_.pause_boundary_iou(base.pauses, deg.pauses)
    ok = bool(pc_match and pde is not None and pde <= re_.G2_PAUSE_DURATION_MAX_ERROR)
    return {"ok": ok, "pause_match": pc_match,
            "pause_count_orig": base.pause_count, "pause_count_deg": deg.pause_count,
            "pause_seconds_orig": round(o, 4), "pause_seconds_deg": round(d, 4),
            "pause_duration_error": None if pde is None else round(pde, 5),
            "pause_iou": iou}


def eval_robustness(ids: list[str], detect, conditions=CONDITIONS) -> dict:
    rows = []
    for sid in ids:
        for cond in conditions:
            if cond == "original":
                continue
            m = metrics_for(CACHE / sid / "original.wav", CACHE / sid / f"{cond}.wav", detect)
            m.update({"speaker": sid, "cond": cond})
            rows.append(m)
    by = {}
    for cond in conditions:
        sub = [r for r in rows if r["cond"] == cond]
        if sub:
            by[cond] = round(sum(r["ok"] for r in sub) / len(sub), 4)
    return {"retest": round(sum(r["ok"] for r in rows) / len(rows), 4),
            "by_condition": by, "rows": rows}


# --------------------------------------------------------------- calibration
PAUSE_MIN = 0.32
MATCH_TOL = 0.10


def score_pauses(detected, reference) -> dict:
    used, tp = set(), 0
    for p in detected:
        b, f = float(p["start"]), float(p["end"])
        for idx, (rs, re_) in enumerate(reference):
            if idx in used:
                continue
            overlap = min(f, re_) - max(b, rs)
            mid = (b + f) / 2
            if overlap >= 0.5 * (re_ - rs) or (rs - MATCH_TOL <= mid <= re_ + MATCH_TOL):
                used.add(idx)
                tp += 1
                break
    fp = len(detected) - tp
    fn = len(reference) - tp
    prec = tp / len(detected) if detected else (1.0 if not reference else 0.0)
    rec = tp / len(reference) if reference else 1.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"detected": len(detected), "tp": tp, "fp": fp, "fn": fn,
            "precision": prec, "recall": rec, "f1": f1}


def eval_calibration(ids: list[str], detect) -> dict:
    tp = fp = fn = det = 0
    per = {}
    for sid in ids:
        tg = re_.CORPUS / "annotation" / f"{sid}.TextGrid"
        words = prosody.parse_textgrid_words(tg)
        ref = [(a.end, b.start) for a, b in zip(words, words[1:])
               if b.start - a.end >= PAUSE_MIN]
        det_pauses = detect(CACHE / sid / "original.wav").pauses
        s = score_pauses(det_pauses, ref)
        per[sid] = {"ref": len(ref), **{k: s[k] for k in ("detected", "tp", "fp", "fn")}}
        tp += s["tp"]; fp += s["fp"]; fn += s["fn"]; det += s["detected"]
    prec = tp / det if det else 1.0
    rec = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"speakers": len(ids), "detected": det, "tp": tp, "fp": fp, "fn": fn,
            "precision": round(prec, 4), "recall": round(rec, 4),
            "f1": round(f1, 4), "per_speaker": per}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["cache", "eval", "grid"])
    ap.add_argument("--detector", default="baseline")
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()
    ids = speaker_ids()
    tune, held = ids[:11], ids[11:]
    if args.action == "cache":
        build_cache()
        return 0
    if args.action == "eval":
        det = detector(args.detector)
        out = {"tune_robustness": eval_robustness(tune, det),
               "tune_calibration": eval_calibration(tune, det)}
        text = json.dumps(out, indent=1)
        if args.json:
            args.json.write_text(text)
        print(json.dumps({k: v for k, v in out.items() if k != "tune_robustness"} |
                         {"robust": out["tune_robustness"]["retest"],
                          "by": out["tune_robustness"]["by_condition"]}, indent=1))
        return 0
    raise SystemExit("grid handled by notebook-style calls in tune-log")


if __name__ == "__main__":
    raise SystemExit(main())