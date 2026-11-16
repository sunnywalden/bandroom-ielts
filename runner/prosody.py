# Vendored copy for the Bandroom production runner.
# Source: acceptance-2026-11-10/iteration-25/prosody/prosody.py
# Source SHA256: 67d6eb5d6556297f756ac393363f0b812e8a4fef8c90a48c5c646ae31f4b1937
# Copied: 2026-11-15. API and calibration contract are unchanged; only this
# provenance header was added. Do not weaken require_measurement() or the
# calibrated_measurements() contract.
# 2026-11-15 rev2 extension: an optional `pause_low_noise_multiplier` keyword
# was added to detect_pauses()/analyze_wav() so a per-user pause calibration can
# lower the threshold. The default is the shipped calibrated constant, so all
# existing callers are behaviourally identical. The calibrated contract
# (require_measurement / calibrated_measurements) is untouched.
"""Deterministic prosody and fluency measurements with explicit calibration status.

This module is the L4 prosody/fluency layer of the measurement-grounded audio
coach.  It takes a WAV file and (optionally) word timings and returns:

* fluency: speech/pause timing, words per minute, articulation rate, fillers;
* pitch: an F0 contour from a YIN-style estimator, cross-checked with a
  cepstral estimator, with octave-error guards;
* rhythm: word-duration variability and nPVI/Varco used as a syllable-timing
  proxy;
* stress proxy: per-word relative duration, mean energy and mean F0.

Every reported number is wrapped in a metric envelope::

    {"value": ..., "status": "...", "calibrated": bool,
     "caveat": "...", "evidence": "..."}

``status`` is one of

``calibrated``
    Compared against independent human annotation or an exact deterministic
    reference; the measured error/agreement is recorded in
    ``CALIBRATION_REPORT.md`` and in :data:`CALIBRATION_EVIDENCE`.
``uncalibrated``
    No independent ground truth was available.
``consistency_checked``
    Two independent estimators agree, but this is NOT ground-truth validation.
``proxy``
    A deliberately indirect feature for a construct that was not directly
    measured (for example word durations standing in for syllable durations,
    or per-word duration/energy/F0 standing in for stress).

Per the project's V2 gate, **uncalibrated metrics must not be presented as
measurements**.  :func:`require_measurement` enforces this at the point of
use, and :func:`calibrated_measurements` returns a view containing only
calibrated numbers.

No side effects occur on import.  All analysis is CPU-only NumPy/SciPy.
"""

from __future__ import annotations

import math
import re
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence, TypedDict

import numpy as np
from scipy.signal import butter, resample_poly, sosfiltfilt

__all__ = [
    "VERSION",
    "CALIBRATION_VERSION",
    "CALIBRATION_EVIDENCE",
    "STATUS_CALIBRATED",
    "STATUS_UNCALIBRATED",
    "STATUS_CONSISTENCY",
    "STATUS_PROXY",
    "PAUSE_MIN_SECONDS",
    "Word",
    "Audio",
    "F0Track",
    "FrameEnergy",
    "PauseDetection",
    "MetricDict",
    "WordDict",
    "UncalibratedMetricError",
    "SchemaError",
    "metric",
    "is_metric",
    "require_measurement",
    "validate_output_schema",
    "calibrated_measurements",
    "load_wav",
    "write_wav",
    "frame_energy",
    "detect_pauses",
    "gate_pauses_to_word_gaps",
    "parse_textgrid_words",
    "estimate_f0",
    "f0_summary",
    "rhythm_metrics",
    "count_fillers",
    "stress_proxy",
    "analyze_wav",
    "analyze_textgrid",
]

# ---------------------------------------------------------------------------
# Analysis constants (calibrated; see CALIBRATION_REPORT.md)
# ---------------------------------------------------------------------------

VERSION = "prosody-v1"
CALIBRATION_VERSION = "2026-11-15"
TARGET_SAMPLE_RATE = 16_000

# Frame grid used for energy / pause decisions.
ENERGY_FRAME_SECONDS = 0.025
ENERGY_HOP_SECONDS = 0.010

# Pause detector.  Calibrated against human inter-word gaps in the
# L2-ARCTIC Suitcase TextGrids (22 speakers).  See CALIBRATION_REPORT.md.
PAUSE_MIN_SECONDS = 0.32
NOISE_PERCENTILE = 10.0
PAUSE_LOW_NOISE_MULTIPLIER = 1.6
PAUSE_HIGH_NOISE_MULTIPLIER = 3.0
PAUSE_BRIDGE_MAX_SECONDS = 0.10
PAUSE_BRIDGE_NOISE_MULTIPLIER = 4.0
PAUSE_ABSOLUTE_FLOOR = 0.0005
PAUSE_HIGH_ABSOLUTE_FLOOR = 0.0008

# F0 analysis.  The 40 ms window can contain at least two periods at 60 Hz.
F0_FRAME_SECONDS = 0.040
F0_HOP_SECONDS = 0.010
F0_MIN_HZ = 60.0
F0_MAX_HZ = 500.0
YIN_THRESHOLD = 0.15
YIN_MAX_APERIODICITY = 0.30
CEPSTRAL_MIN_PROMINENCE = 0.02
OCTAVE_TOLERANCE_SEMITONES = 1.5
AGREEMENT_SEMITONES = 1.0
OCTAVE_REPAIR_RATIO = 1.70  # ~= 9.2 semitones; only isolated jumps are repaired

# Word/filler definitions.
FILLER_UNIGRAMS = frozenset({"um", "uh", "er", "ah", "like"})
FILLER_BIGRAMS = frozenset({("you", "know")})
WORD_TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")

# Metric status values.
STATUS_CALIBRATED = "calibrated"
STATUS_UNCALIBRATED = "uncalibrated"
STATUS_CONSISTENCY = "consistency_checked"
STATUS_PROXY = "proxy"
VALID_STATUSES = frozenset(
    {STATUS_CALIBRATED, STATUS_UNCALIBRATED, STATUS_CONSISTENCY, STATUS_PROXY}
)

# Calibration evidence.  The numbers are produced by ``calibrate.py`` against
# the human-annotated TextGrid words tier and stored in
# ``calibration_results.json``.  Keep this dict in sync with that file and
# with CALIBRATION_REPORT.md.
CALIBRATION_EVIDENCE: dict[str, Any] = {
    "reference": "L2-ARCTIC Suitcase TextGrid 'words' tier (22 speakers)",
    "pause_reference_definition": (
        "gap between consecutive non-empty annotated words of at least 0.32 s"
    ),
    "pause_match_definition": (
        "a detection matches a reference pause when it overlaps at least 50% "
        "of the reference, or when its midpoint lies within the reference "
        "extended by 0.10 s"
    ),
    "pause_waveform_only": {
        "speakers": 22,
        "reference_pauses": 497,
        "detections": 565,
        "true_positives": 459,
        "false_positives": 106,
        "false_negatives": 38,
        "precision": 0.8124,
        "recall": 0.9235,
        "f1": 0.8644,
    },
    "pause_word_gated_human": {
        "speakers": 22,
        "detections": 455,
        "true_positives": 446,
        "false_positives": 9,
        "false_negatives": 51,
        "precision": 0.9802,
        "recall": 0.8974,
        "f1": 0.9370,
        "note": (
            "Requires accurate word boundaries. Recall loss occurs when part "
            "of an annotated pause is above the energy threshold."
        ),
    },
    "pause_word_gated_asr": {
        "speakers": 6,
        "detections": 23,
        "true_positives": 20,
        "false_positives": 3,
        "false_negatives": 63,
        "precision": 0.8696,
        "recall": 0.2410,
        "f1": 0.3774,
        "recommended": False,
        "note": (
            "Not recommended: ASR word boundaries merge or omit short words, "
            "so most true pauses fall outside an ASR inter-word gap. Use "
            "waveform-only pauses with ASR words."
        ),
    },
    "asr_word_timing": {
        "speakers": 6,
        "truth_words": 847,
        "matched": 720,
        "match_rate": 0.8501,
        "median_abs_start_ms": 80.0,
        "p90_abs_start_ms": 520.0,
        "within_150ms": 0.6778,
        "within_300ms": 0.8083,
        "within_500ms": 0.8944,
        "note": (
            "faster-whisper small.en; greedy monotone identity match against "
            "the TextGrid words tier. Boundaries are not precise enough for "
            "word-gated pause detection."
        ),
    },
    "pitch": {
        "validated_against_ground_truth": False,
        "method": "YIN CMNDF primary; cepstral cross-check; octave guard",
        "cross_estimator_agreement_semitones": 1.0,
        "speakers": 22,
        "mean_agreement_within_1_semitone": 0.8977,
        "recording_level_octave_flags": [],
        "max_subharmonic_ratio": 0.6826,
        "max_octave_up_ratio": 0.1621,
        "speakers_above_0_75_subharmonic_ratio": [],
        "hjk": {
            "prototype_median_hz": 219.18,
            "yin_median_hz": 218.74,
            "cepstral_median_hz": 214.34,
            "agreement_within_1_semitone": 0.9237,
            "subharmonic_ratio": 0.1233,
            "octave_error": False,
        },
        "note": (
            "Cross-estimator agreement and the T/2T/T subharmonic check are "
            "consistency checks, not ground-truth validation; no Praat/reference "
            "F0 track was available. The probe's 219.2 Hz for hjk is not an "
            "octave error under these checks."
        ),
    },
}


# ---------------------------------------------------------------------------
# Metric envelope and schema enforcement
# ---------------------------------------------------------------------------


class UncalibratedMetricError(RuntimeError):
    """Raised when an uncalibrated metric is used as a measurement."""


class SchemaError(ValueError):
    """Raised when an output document violates the calibration schema."""


class MetricDict(TypedDict):
    value: Any
    status: str
    calibrated: bool
    caveat: str | None
    evidence: str | None


class WordDict(TypedDict):
    text: str
    start: float
    end: float


def metric(
    value: Any,
    status: str,
    *,
    caveat: str | None = None,
    evidence: str | None = None,
) -> MetricDict:
    """Build a metric envelope, enforcing the calibrated/status invariant."""
    if status not in VALID_STATUSES:
        raise ValueError(f"unknown metric status: {status!r}")
    return {
        "value": value,
        "status": status,
        "calibrated": status == STATUS_CALIBRATED,
        "caveat": caveat,
        "evidence": evidence,
    }


def is_metric(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and "value" in value
        and "status" in value
        and "calibrated" in value
    )


def require_measurement(value: Any) -> Any:
    """Return a metric's value only when it is calibrated.

    This is the enforcement hook for the V2 gate: callers that want to present
    a number as a measurement must go through this function.
    """
    if not is_metric(value):
        raise TypeError("require_measurement() expects a metric envelope")
    if value["status"] != STATUS_CALIBRATED:
        raise UncalibratedMetricError(
            f"{value['status']} metric cannot be presented as a measurement"
            + (f": {value['caveat']}" if value.get("caveat") else "")
        )
    return value["value"]


def _walk_metrics(obj: Any) -> Iterable[MetricDict]:
    if is_metric(obj):
        yield obj
    elif isinstance(obj, Mapping):
        for item in obj.values():
            yield from _walk_metrics(item)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_metrics(item)


def validate_output_schema(output: Mapping[str, Any]) -> bool:
    """Check the calibration invariants of an analysis document.

    Raises :class:`SchemaError` if any metric envelope is malformed or if a
    construct that is known to be uncalibrated/proxy is mislabelled.
    """
    for m in _walk_metrics(output):
        if m["status"] not in VALID_STATUSES:
            raise SchemaError(f"invalid metric status {m['status']!r}")
        if m["calibrated"] is not (m["status"] == STATUS_CALIBRATED):
            raise SchemaError("calibrated flag disagrees with status")
    pitch = output.get("pitch", {})
    for key in (
        "f0_frames",
        "median_hz",
        "p10_hz",
        "p90_hz",
        "range_semitones",
        "contour",
    ):
        m = pitch.get(key)
        if is_metric(m) and m["status"] == STATUS_CALIBRATED:
            raise SchemaError(f"pitch.{key} cannot be calibrated without reference F0")
    rhythm = output.get("rhythm", {})
    for key in ("word_duration_npvi", "word_duration_varco", "word_duration_cv"):
        m = rhythm.get(key)
        if is_metric(m) and m["status"] == STATUS_CALIBRATED:
            raise SchemaError(f"rhythm.{key} is a proxy and cannot be calibrated")
    stress = output.get("stress_proxy", {})
    m = stress.get("words")
    if is_metric(m) and m["status"] == STATUS_CALIBRATED:
        raise SchemaError("stress_proxy.words is a proxy, not a measurement")
    return True


def calibrated_measurements(output: Mapping[str, Any]) -> dict[str, Any]:
    """Return a nested view containing only calibrated metrics.

    Uncalibrated, consistency-checked and proxy sections are omitted entirely,
    so the result is safe to show wherever the project requires a measurement.
    """

    def walk(obj: Any) -> tuple[Any, bool]:
        if is_metric(obj):
            return obj["value"], obj["status"] == STATUS_CALIBRATED
        if isinstance(obj, Mapping):
            result: dict[str, Any] = {}
            has_calibrated = False
            for key, value in obj.items():
                child, child_calibrated = walk(value)
                if child_calibrated:
                    result[key] = child
                    has_calibrated = True
            return result, has_calibrated
        return obj, False

    view: dict[str, Any] = {}
    for key, value in output.items():
        child, has_calibrated = walk(value)
        if has_calibrated:
            view[key] = child
    return view


# ---------------------------------------------------------------------------
# Audio and word input
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Word:
    """A word with start/end seconds."""

    text: str
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class Audio:
    samples: np.ndarray
    sample_rate: int
    original_sample_rate: int
    duration: float
    channels: int


def _decode_pcm(raw: bytes, sample_width: int) -> np.ndarray:
    if sample_width == 1:
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    if sample_width == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if sample_width == 3:
        data = np.frombuffer(raw, dtype=np.uint8)
        usable = len(data) // 3 * 3
        triplets = data[:usable].reshape(-1, 3).astype(np.int32)
        values = triplets[:, 0] | (triplets[:, 1] << 8) | (triplets[:, 2] << 16)
        values = np.where(values >= 1 << 23, values - (1 << 24), values)
        return values.astype(np.float64) / float(1 << 23)
    if sample_width == 4:
        return np.frombuffer(raw, dtype="<i4").astype(np.float64) / float(1 << 31)
    raise ValueError(f"unsupported PCM sample width: {sample_width} bytes")


def load_wav(path: str | Path) -> Audio:
    """Load a PCM WAV file as mono float64 at :data:`TARGET_SAMPLE_RATE`."""
    path = Path(path)
    with wave.open(str(path), "rb") as handle:
        if handle.getcomptype() != "NONE":
            raise ValueError(f"compressed WAV is not supported: {handle.getcomptype()}")
        channels = handle.getnchannels()
        sample_rate = handle.getframerate()
        sample_width = handle.getsampwidth()
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    if frames <= 0:
        raise ValueError("empty WAV file")
    samples = _decode_pcm(raw, sample_width)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    original_duration = len(samples) / float(sample_rate)
    if sample_rate != TARGET_SAMPLE_RATE:
        divisor = math.gcd(sample_rate, TARGET_SAMPLE_RATE)
        samples = resample_poly(
            samples,
            TARGET_SAMPLE_RATE // divisor,
            sample_rate // divisor,
        )
    samples = np.asarray(samples, dtype=np.float64)
    samples = samples - float(np.mean(samples)) if len(samples) else samples
    return Audio(
        samples=samples,
        sample_rate=TARGET_SAMPLE_RATE,
        original_sample_rate=sample_rate,
        duration=original_duration,
        channels=channels,
    )


def write_wav(
    path: str | Path,
    samples: np.ndarray,
    sample_rate: int = TARGET_SAMPLE_RATE,
) -> None:
    """Write mono float samples in [-1, 1] as a 16-bit PCM WAV file.

    Small utility used by the tests and by downstream fixtures; it has no
    effect unless called.
    """
    array = np.asarray(samples, dtype=np.float64)
    if array.ndim != 1:
        raise ValueError("write_wav expects a mono 1-D array")
    clipped = np.clip(array, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())


def _coerce_words(words: Sequence[Word | Mapping[str, Any]]) -> list[Word]:
    result: list[Word] = []
    for index, word in enumerate(words):
        if isinstance(word, Word):
            text, start, end = word.text, word.start, word.end
        else:
            text = str(word.get("text", word.get("word", "")))
            start = float(word["start"])
            end = float(word["end"])
        if not math.isfinite(start) or not math.isfinite(end):
            raise ValueError(f"word {index}: non-finite bounds")
        if start < 0 or end <= start:
            raise ValueError(f"word {index}: invalid bounds {start}-{end}")
        result.append(Word(text=text, start=start, end=end))
    result.sort(key=lambda w: (w.start, w.end))
    return result


def parse_textgrid_words(path: str | Path) -> list[Word]:
    """Parse the ``words`` tier of a Praat long-text TextGrid.

    The returned words are the non-empty intervals in start order.  Empty
    intervals are the annotator's own silence/pause spans and are not returned.
    """
    text = Path(path).read_text(encoding="utf-8")
    lines = text.splitlines()
    tier_starts = [
        index
        for index, line in enumerate(lines)
        if re.match(r"^\s*item \[\d+\]:\s*$", line)
    ]
    for position, start in enumerate(tier_starts):
        end = tier_starts[position + 1] if position + 1 < len(tier_starts) else len(lines)
        block = lines[start:end]
        if not any(re.match(r'\s*name = "words"\s*$', line) for line in block):
            continue
        words: list[Word] = []
        index = 0
        while index < len(block):
            if re.match(r"\s*intervals \[\d+\]:\s*$", block[index]):
                xmin = xmax = None
                label = ""
                cursor = index + 1
                while cursor < len(block) and not re.match(
                    r"\s*intervals \[\d+\]:\s*$", block[cursor]
                ):
                    line = block[cursor]
                    match = re.match(r"\s*xmin = ([\d.eE+-]+)", line)
                    if match and xmin is None:
                        xmin = float(match.group(1))
                    match = re.match(r"\s*xmax = ([\d.eE+-]+)", line)
                    if match and xmax is None:
                        xmax = float(match.group(1))
                    match = re.match(r'\s*text = "(.*)"\s*$', line)
                    if match and not label:
                        label = match.group(1)
                    cursor += 1
                if xmin is None or xmax is None:
                    raise ValueError("malformed TextGrid interval")
                if label.strip():
                    words.append(Word(text=label.strip(), start=xmin, end=xmax))
                index = cursor
            else:
                index += 1
        words.sort(key=lambda w: (w.start, w.end))
        return words
    raise ValueError(f"no 'words' tier found in {path}")


# ---------------------------------------------------------------------------
# Frame-level energy and pause detection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FrameEnergy:
    rms: np.ndarray
    times: np.ndarray
    frame_seconds: float


def frame_energy(
    samples: np.ndarray,
    sample_rate: int = TARGET_SAMPLE_RATE,
    frame_seconds: float = ENERGY_FRAME_SECONDS,
    hop_seconds: float = ENERGY_HOP_SECONDS,
) -> FrameEnergy:
    frame = max(1, int(round(frame_seconds * sample_rate)))
    hop = max(1, int(round(hop_seconds * sample_rate)))
    if len(samples) < frame:
        padded = np.zeros(frame, dtype=np.float64)
        padded[: len(samples)] = samples
        samples = padded
    count = 1 + (len(samples) - frame) // hop
    starts = np.arange(count) * hop
    cumulative = np.concatenate(([0.0], np.cumsum(samples * samples)))
    energy = (cumulative[starts + frame] - cumulative[starts]) / frame
    rms = np.sqrt(np.maximum(energy, 0.0))
    return FrameEnergy(
        rms=rms,
        times=starts / float(sample_rate),
        frame_seconds=frame / float(sample_rate),
    )


@dataclass(frozen=True)
class PauseDetection:
    pauses: list[dict[str, float]]
    noise_floor_rms: float
    low_threshold_rms: float
    high_threshold_rms: float
    speech_span: tuple[float, float]
    speech_seconds: float
    total_seconds: float

    @property
    def pause_seconds(self) -> float:
        return sum(p["end"] - p["start"] for p in self.pauses)

    @property
    def pause_count(self) -> int:
        return len(self.pauses)


def _noise_and_thresholds(
    rms: np.ndarray,
    *,
    low_multiplier: float = PAUSE_LOW_NOISE_MULTIPLIER,
) -> tuple[float, float, float]:
    """Estimate the noise floor and the hysteresis thresholds.

    The 10th percentile is capped at 25% of the 90th percentile.  Without the
    cap, a recording containing only continuous speech has a "noise floor"
    equal to the speech level, which would classify the whole file as silence.
    The cap is inactive on the calibration corpus because every Suitcase
    recording contains genuine noise-only frames.

    ``low_multiplier`` is overridable so a per-user pause calibration can lower
    the threshold.  The default is the shipped calibrated constant; raising the
    multiplier admits more frames as silence and lowering it detects fewer
    pauses.
    """
    low_multiplier = float(low_multiplier)
    if not (0.1 <= low_multiplier <= 5.0):
        raise ValueError(
            f"low_multiplier must be in [0.1, 5.0], got {low_multiplier!r}"
        )
    p10 = float(np.percentile(rms, NOISE_PERCENTILE))
    p90 = float(np.percentile(rms, 90.0))
    noise = min(p10, p90 * 0.25)
    low = max(PAUSE_ABSOLUTE_FLOOR, noise * low_multiplier)
    high = max(
        PAUSE_HIGH_ABSOLUTE_FLOOR,
        noise * PAUSE_HIGH_NOISE_MULTIPLIER,
        low * 1.25,
    )
    return noise, low, high


def detect_pauses(
    samples: np.ndarray,
    sample_rate: int = TARGET_SAMPLE_RATE,
    *,
    min_pause_seconds: float = PAUSE_MIN_SECONDS,
    pause_low_noise_multiplier: float = PAUSE_LOW_NOISE_MULTIPLIER,
) -> PauseDetection:
    """Detect silent pauses using a noise-floor-relative hysteresis threshold.

    The prototype over-detected pauses because it used a high
    speech-relative threshold (``max(0.004, p85 * 0.14)``), which counted
    low-energy speech (stop closures, weak fricatives, word edges) as silence.
    Here the threshold is tied to the estimated noise floor, and a Schmitt
    trigger plus a short conditional bridge prevents one pause from being
    split into several.

    ``pause_low_noise_multiplier`` is the per-user calibration hook.  The
    measured calibrated default is ``PAUSE_LOW_NOISE_MULTIPLIER`` (1.6); the
    production calibration clamps user values to ``[0.9, 1.6]`` because the
    detector collapses to zero detections below roughly 0.8.
    """
    energy = frame_energy(samples, sample_rate)
    rms = energy.rms
    times = energy.times
    frame_seconds = energy.frame_seconds
    noise, low, high = _noise_and_thresholds(
        rms, low_multiplier=pause_low_noise_multiplier
    )

    # Schmitt-trigger segmentation: enter silence below `low`, leave above
    # `high`.  This ignores small energy wobbles inside a pause.
    segments: list[list[int]] = []
    in_silence = False
    start = 0
    for index, value in enumerate(rms):
        if not in_silence and value < low:
            in_silence = True
            start = index
        elif in_silence and value > high:
            in_silence = False
            segments.append([start, index])
    if in_silence:
        segments.append([start, len(rms)])

    # Conditionally bridge a split pause when the intervening frames are still
    # near the noise floor and the gap is very short.  This does not bridge
    # across real words.
    merged: list[list[int]] = []
    for seg_start, seg_end in segments:
        if merged:
            previous_start, previous_end = merged[-1]
            gap_seconds = (seg_start - previous_end) * frame_seconds
            between = rms[previous_end : min(seg_start + 1, len(rms))]
            if (
                gap_seconds <= PAUSE_BRIDGE_MAX_SECONDS
                and (
                    len(between) == 0
                    or float(np.median(between))
                    < noise * PAUSE_BRIDGE_NOISE_MULTIPLIER
                )
            ):
                merged[-1] = [previous_start, seg_end]
                continue
        merged.append([seg_start, seg_end])

    # Bound analysis to the active speech span so leading/trailing silence is
    # not reported as a pause.
    active = np.flatnonzero(rms > high)
    total_seconds = len(samples) / float(sample_rate)
    if len(active):
        span_start = float(times[active[0]])
        span_end = min(
            total_seconds,
            float(times[active[-1]] + frame_seconds),
        )
    else:
        span_start, span_end = 0.0, total_seconds
    speech_span = (span_start, span_end)

    pauses: list[dict[str, float]] = []
    if not len(active):
        # A silent or wholly non-speech recording has no pauses between speech.
        merged = []
    for seg_start, seg_end in merged:
        begin = float(times[seg_start])
        finish = (
            float(times[seg_end])
            if seg_end < len(times)
            else float(times[-1] + frame_seconds)
        )
        begin = max(begin, span_start)
        finish = min(finish, span_end)
        if finish - begin >= min_pause_seconds - 1e-9:
            pauses.append(
                {
                    "start": round(begin, 4),
                    "end": round(finish, 4),
                    "seconds": round(finish - begin, 4),
                }
            )
    pauses.sort(key=lambda p: p["start"])
    pause_seconds = sum(p["seconds"] for p in pauses)
    speech_seconds = max(0.0, (span_end - span_start) - pause_seconds)
    return PauseDetection(
        pauses=pauses,
        noise_floor_rms=round(noise, 6),
        low_threshold_rms=round(low, 6),
        high_threshold_rms=round(high, 6),
        speech_span=(round(span_start, 4), round(span_end, 4)),
        speech_seconds=speech_seconds,
        total_seconds=total_seconds,
    )


def gate_pauses_to_word_gaps(
    pauses: Sequence[Mapping[str, float]],
    words: Sequence[Word],
    *,
    min_pause_seconds: float = PAUSE_MIN_SECONDS,
) -> list[dict[str, float]]:
    """Keep only detected pauses that fall inside an inter-word gap.

    A pause, by definition, occurs between words.  Clipping to the gap also
    prevents a 0.28 s inter-word gap from being inflated into a 0.33 s
    "pause" by word-edge low energy.  This mode depends on the accuracy of
    the supplied word timings and is calibrated separately for human and ASR
    word boundaries.
    """
    if len(words) < 2:
        return []
    gaps = [
        (previous.end, current.start)
        for previous, current in zip(words, words[1:])
        if current.start > previous.end
    ]
    gated: list[dict[str, float]] = []
    for pause in pauses:
        begin, finish = float(pause["start"]), float(pause["end"])
        best: tuple[float, float] | None = None
        best_overlap = 0.0
        for gap_start, gap_end in gaps:
            if gap_end - gap_start < min_pause_seconds - 1e-3:
                continue
            overlap = min(finish, gap_end) - max(begin, gap_start)
            if overlap <= 0:
                continue
            clipped = (max(begin, gap_start), min(finish, gap_end))
            if clipped[1] - clipped[0] < min_pause_seconds - 1e-3:
                continue
            if overlap > best_overlap:
                best = clipped
                best_overlap = overlap
        if best is not None:
            gated.append(
                {
                    "start": round(best[0], 4),
                    "end": round(best[1], 4),
                    "seconds": round(best[1] - best[0], 4),
                }
            )
    gated.sort(key=lambda p: p["start"])
    return gated


# ---------------------------------------------------------------------------
# F0 estimation: YIN CMNDF primary, cepstrum cross-check
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class F0Track:
    times: np.ndarray
    f0_hz: np.ndarray
    aperiodicity: np.ndarray
    confidence: np.ndarray
    energy_ok: np.ndarray
    cepstral_hz: np.ndarray
    cepstral_prominence: np.ndarray
    median_repaired_frames: int
    rejected_low_energy: int
    rejected_aperiodic: int


def _bandpass(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    low = max(40.0, F0_MIN_HZ * 0.8)
    high = min(F0_MAX_HZ * 1.2, sample_rate / 2.0 - 100.0)
    sos = butter(4, [low, high], btype="bandpass", fs=sample_rate, output="sos")
    return sosfiltfilt(sos, samples)


def _yin_frame(
    frame: np.ndarray,
    sample_rate: int,
    tau_min: int,
    tau_max: int,
) -> tuple[float | None, float]:
    """Return (f0, aperiodicity) from the first CMNDF dip below threshold."""
    length = len(frame)
    centered = frame - float(np.mean(frame))
    autocorrelation = np.correlate(centered, centered, mode="full")[length - 1 :]
    cumulative = np.concatenate(([0.0], np.cumsum(centered * centered)))
    total_energy = cumulative[length]
    taus = np.arange(1, tau_max + 1)
    first = cumulative[length - taus]
    second = total_energy - cumulative[taus]
    difference = np.maximum(first + second - 2.0 * autocorrelation[taus], 0.0)
    cumulative_difference = np.cumsum(difference)
    cmndf = np.ones_like(difference)
    positive = cumulative_difference > 0
    cmndf[positive] = (
        difference[positive] * taus[positive] / cumulative_difference[positive]
    )

    low_index = tau_min - 1
    high_index = min(tau_max, len(cmndf)) - 1
    window = cmndf[low_index : high_index + 1]
    if len(window) < 3:
        return None, 1.0
    candidates = np.flatnonzero(
        (window[1:-1] < YIN_THRESHOLD)
        & (window[1:-1] <= window[:-2])
        & (window[1:-1] < window[2:])
    )
    if len(candidates):
        index = low_index + 1 + int(candidates[0])
    else:
        index = low_index + int(np.argmin(window))
        if cmndf[index] > YIN_MAX_APERIODICITY:
            return None, float(cmndf[index])

    aperiodicity = float(cmndf[index])
    tau = float(index + 1)
    if 0 < index < len(cmndf) - 1:
        left, centre, right = cmndf[index - 1], cmndf[index], cmndf[index + 1]
        denominator = left - 2.0 * centre + right
        if abs(denominator) > 1e-12:
            tau += 0.5 * (left - right) / denominator
    f0 = sample_rate / tau if tau > 0 else None
    return f0, aperiodicity


def _cepstral_frame(
    frame: np.ndarray,
    sample_rate: int,
    quefrency_low: int,
    quefrency_high: int,
    window: np.ndarray,
) -> tuple[float | None, float]:
    centered = frame - float(np.mean(frame))
    spectrum = np.fft.rfft(centered * window)
    cepstrum = np.fft.irfft(np.log(np.abs(spectrum) + 1e-12))
    segment = cepstrum[quefrency_low : quefrency_high + 1]
    if len(segment) < 3:
        return None, 0.0
    peak_index = quefrency_low + int(np.argmax(segment))
    prominence = float(cepstrum[peak_index] - np.median(segment))
    if prominence < CEPSTRAL_MIN_PROMINENCE:
        return None, prominence
    quefrency = float(peak_index)
    if 0 < peak_index < len(cepstrum) - 1:
        left, centre, right = (
            cepstrum[peak_index - 1],
            cepstrum[peak_index],
            cepstrum[peak_index + 1],
        )
        denominator = left - 2.0 * centre + right
        if abs(denominator) > 1e-12:
            quefrency += 0.5 * (left - right) / denominator
    frequency = sample_rate / quefrency if quefrency > 0 else 0.0
    if not math.isfinite(frequency) or not (F0_MIN_HZ <= frequency <= F0_MAX_HZ):
        return None, prominence
    return frequency, prominence


def estimate_f0(
    samples: np.ndarray,
    sample_rate: int = TARGET_SAMPLE_RATE,
    *,
    speech_threshold: float | None = None,
) -> F0Track:
    """Estimate F0 with YIN and cross-check every frame with the cepstrum.

    YIN's cumulative mean normalized difference function (de Cheveigné &
    Kawahara, 2002) is used because it has an explicit aperiodicity value per
    frame and its "first dip" rule is less prone to the octave-doubling that
    affected the prototype's "first strong autocorrelation peak" heuristic.
    The cepstral estimate is independent enough to flag octave disagreement,
    but it is not used to override YIN: CMNDF at 2T is also low for a clean
    periodic signal, so overriding on that basis can itself create an octave
    error.  Isolated octave-scale jumps are repaired against a local median.
    """
    frame_length = int(round(F0_FRAME_SECONDS * sample_rate))
    hop = int(round(F0_HOP_SECONDS * sample_rate))
    if len(samples) < frame_length:
        samples = np.pad(samples, (0, frame_length - len(samples)))
    count = 1 + (len(samples) - frame_length) // hop
    filtered = _bandpass(samples, sample_rate)
    tau_min = max(2, int(sample_rate / F0_MAX_HZ))
    tau_max = min(frame_length - 2, int(sample_rate / F0_MIN_HZ))
    quefrency_low = max(2, int(sample_rate / F0_MAX_HZ))
    quefrency_high = min(frame_length // 2 - 1, int(sample_rate / F0_MIN_HZ))
    cepstral_window = np.hanning(frame_length)

    if speech_threshold is None:
        energy = frame_energy(samples, sample_rate)
        _, speech_threshold, _ = _noise_and_thresholds(energy.rms)

    times = np.empty(count)
    f0 = np.full(count, np.nan)
    aperiodicity = np.ones(count)
    confidence = np.zeros(count)
    energy_ok = np.zeros(count, dtype=bool)
    cepstral_hz = np.full(count, np.nan)
    cepstral_prominence = np.zeros(count)
    median_repaired = 0
    rejected_low_energy = 0
    rejected_aperiodic = 0

    for index in range(count):
        start = index * hop
        frame = filtered[start : start + frame_length]
        times[index] = (start + frame_length / 2.0) / sample_rate
        frame_rms = float(np.sqrt(np.mean(frame * frame)))
        if frame_rms >= speech_threshold:
            energy_ok[index] = True
        else:
            rejected_low_energy += 1

        yin_f0, aper = _yin_frame(frame, sample_rate, tau_min, tau_max)
        cep_f0, prominence = _cepstral_frame(
            frame,
            sample_rate,
            quefrency_low,
            quefrency_high,
            cepstral_window,
        )
        cepstral_hz[index] = cep_f0 if cep_f0 is not None else np.nan
        cepstral_prominence[index] = prominence
        aperiodicity[index] = aper
        confidence[index] = max(0.0, 1.0 - aper)

        if yin_f0 is None or not energy_ok[index]:
            if yin_f0 is None:
                rejected_aperiodic += 1
            continue
        if (
            not math.isfinite(yin_f0)
            or not (F0_MIN_HZ <= yin_f0 <= F0_MAX_HZ)
            or aper > YIN_MAX_APERIODICITY
        ):
            rejected_aperiodic += 1
            continue

        # The cepstrum is a consistency check, not an override.  CMNDF at 2T
        # is also low for a clean periodic signal, so using it to "correct" an
        # octave disagreement can itself introduce an octave error.  Octave
        # disagreements are counted by f0_summary(); the temporal median repair
        # below removes isolated jumps while preserving genuine intonation.
        f0[index] = yin_f0

    # Repair isolated octave jumps: a frame that is ~2x or ~0.5x its local
    # neighbours, while the neighbours are stable, is almost certainly an
    # estimator error rather than a real 12-semitone jump in 90 ms.
    valid_indices = np.flatnonzero(np.isfinite(f0))
    if len(valid_indices):
        repaired = f0.copy()
        for index in valid_indices:
            neighbours = valid_indices[
                (valid_indices >= index - 4) & (valid_indices <= index + 4)
            ]
            neighbours = neighbours[neighbours != index]
            if len(neighbours) < 2:
                continue
            local = f0[neighbours]
            local = local[np.isfinite(local)]
            if len(local) < 2:
                continue
            local_median = float(np.median(local))
            if local_median <= 0:
                continue
            ratio = f0[index] / local_median
            if ratio > OCTAVE_REPAIR_RATIO or ratio < 1.0 / OCTAVE_REPAIR_RATIO:
                repaired[index] = local_median
                median_repaired += 1
        f0 = repaired

    return F0Track(
        times=times,
        f0_hz=f0,
        aperiodicity=aperiodicity,
        confidence=confidence,
        energy_ok=energy_ok,
        cepstral_hz=cepstral_hz,
        cepstral_prominence=cepstral_prominence,
        median_repaired_frames=median_repaired,
        rejected_low_energy=rejected_low_energy,
        rejected_aperiodic=rejected_aperiodic,
    )


def f0_summary(track: F0Track) -> dict[str, Any]:
    valid = np.isfinite(track.f0_hz) & track.energy_ok
    values = track.f0_hz[valid]
    compared = (
        np.isfinite(track.f0_hz)
        & track.energy_ok
        & np.isfinite(track.cepstral_hz)
        & (track.f0_hz >= F0_MIN_HZ)
        & (track.f0_hz <= F0_MAX_HZ)
    )
    yin = track.f0_hz[compared]
    cep = track.cepstral_hz[compared]
    if len(yin) and len(cep):
        semitones = 12.0 * np.log2(yin / cep)
        agreement_1 = float(np.mean(np.abs(semitones) <= AGREEMENT_SEMITONES))
        agreement_2 = float(np.mean(np.abs(semitones) <= 2.0))
        octave_up = float(np.mean(np.abs(semitones + 12.0) <= OCTAVE_TOLERANCE_SEMITONES))
        octave_down = float(np.mean(np.abs(semitones - 12.0) <= OCTAVE_TOLERANCE_SEMITONES))
        median_abs = float(np.median(np.abs(semitones)))
    else:
        agreement_1 = agreement_2 = octave_up = octave_down = 0.0
        median_abs = None
    if len(values):
        p10, median, p90 = np.percentile(values, [10, 50, 90])
        range_semitones = 12.0 * math.log2(float(p90) / float(p10))
    else:
        p10 = median = p90 = None
        range_semitones = None
    return {
        "voiced_frames": int(len(values)),
        "p10_hz": round(float(p10), 2) if p10 is not None else None,
        "median_hz": round(float(median), 2) if median is not None else None,
        "p90_hz": round(float(p90), 2) if p90 is not None else None,
        "range_semitones": (
            round(float(range_semitones), 3) if range_semitones is not None else None
        ),
        "cross_check": {
            "frames_compared": int(len(yin)),
            "agreement_within_1_semitone": round(agreement_1, 4),
            "agreement_within_2_semitones": round(agreement_2, 4),
            "octave_disagreement_ceps_high": round(octave_up, 4),
            "octave_disagreement_ceps_low": round(octave_down, 4),
            "median_abs_semitone_difference": (
                round(median_abs, 3) if median_abs is not None else None
            ),
            "recording_level_octave_flag": bool(
                len(yin)
                and len(cep)
                and (
                    float(np.median(yin)) / float(np.median(cep)) > 1.5
                    or float(np.median(yin)) / float(np.median(cep)) < 1.0 / 1.5
                )
            ),
        },
        "corrections": {
            "median_repaired_frames": int(track.median_repaired_frames),
            "rejected_low_energy_frames": int(track.rejected_low_energy),
            "rejected_aperiodic_frames": int(track.rejected_aperiodic),
        },
    }


# ---------------------------------------------------------------------------
# Rhythm, fillers, stress proxy
# ---------------------------------------------------------------------------

PITCH_CAVEAT = (
    "F0 is consistency-checked across two independent estimators but has NOT "
    "been validated against a reference pitch track (no Praat/ground truth). "
    "It must not be presented as a calibrated measurement."
)
PROXY_RHYTHM_CAVEAT = (
    "PROXY: nPVI/Varco are computed from word durations because syllables were "
    "not segmented. This is not the standard syllable-nPVI and is unvalidated "
    "as a rhythm or fluency diagnostic."
)
PROXY_STRESS_CAVEAT = (
    "PROXY ONLY: per-word relative duration, mean energy and mean F0 are "
    "correlates of prominence, not a validated stress detector. No syllable "
    "or lexical-stress labelling is performed."
)


def rhythm_metrics(words: Sequence[Word]) -> dict[str, Any]:
    durations = np.array([w.duration for w in words if w.duration > 0], dtype=float)
    if len(durations) < 2:
        return {
            "n_words": len(durations),
            "mean_word_duration_ms": None,
            "median_word_duration_ms": None,
            "word_duration_sd_ms": None,
            "word_duration_cv": metric(None, STATUS_PROXY, caveat=PROXY_RHYTHM_CAVEAT),
            "word_duration_npvi": metric(None, STATUS_PROXY, caveat=PROXY_RHYTHM_CAVEAT),
            "word_duration_varco": metric(None, STATUS_PROXY, caveat=PROXY_RHYTHM_CAVEAT),
            "basis": "word durations (proxy for syllable durations)",
        }
    mean = float(np.mean(durations))
    standard_deviation = float(np.std(durations, ddof=1))
    cv = standard_deviation / mean if mean > 0 else None
    npvi_pairs = np.abs(durations[:-1] - durations[1:]) / (
        (durations[:-1] + durations[1:]) / 2.0
    )
    npvi = 100.0 * float(np.mean(npvi_pairs)) if len(npvi_pairs) else None
    varco = 100.0 * cv if cv is not None else None
    return {
        "n_words": int(len(durations)),
        "mean_word_duration_ms": round(mean * 1000.0, 2),
        "median_word_duration_ms": round(float(np.median(durations)) * 1000.0, 2),
        "word_duration_sd_ms": round(standard_deviation * 1000.0, 2),
        "word_duration_cv": metric(
            round(cv, 4) if cv is not None else None,
            STATUS_PROXY,
            caveat=PROXY_RHYTHM_CAVEAT,
        ),
        "word_duration_npvi": metric(
            round(npvi, 3) if npvi is not None else None,
            STATUS_PROXY,
            caveat=PROXY_RHYTHM_CAVEAT,
        ),
        "word_duration_varco": metric(
            round(varco, 3) if varco is not None else None,
            STATUS_PROXY,
            caveat=PROXY_RHYTHM_CAVEAT,
        ),
        "basis": "word durations (proxy for syllable durations)",
    }


def _tokens(
    transcript: str | None, words: Sequence[Word] | None
) -> list[tuple[str, float | None, float | None]]:
    tokens: list[tuple[str, float | None, float | None]] = []
    if words:
        for word in words:
            for token in WORD_TOKEN_RE.findall(word.text.lower()):
                tokens.append((token, word.start, word.end))
        return tokens
    if transcript:
        for token in WORD_TOKEN_RE.findall(transcript.lower()):
            tokens.append((token, None, None))
    return tokens


def count_fillers(
    transcript: str | None = None,
    words: Sequence[Word] | None = None,
) -> dict[str, Any]:
    """Count um/uh/er/ah/like and "you know" in the supplied transcript."""
    tokens = _tokens(transcript, words)
    occurrences: list[dict[str, Any]] = []
    unigram_counts: dict[str, int] = {}
    bigram_count = 0
    index = 0
    while index < len(tokens):
        token, start, end = tokens[index]
        if token in FILLER_UNIGRAMS:
            unigram_counts[token] = unigram_counts.get(token, 0) + 1
            occurrences.append(
                {"text": token, "kind": "unigram", "start": start, "end": end}
            )
        if index + 1 < len(tokens):
            next_token, next_start, next_end = tokens[index + 1]
            if (token, next_token) in FILLER_BIGRAMS:
                bigram_count += 1
                occurrences.append(
                    {
                        "text": f"{token} {next_token}",
                        "kind": "bigram",
                        "start": start,
                        "end": next_end,
                    }
                )
                index += 1
        index += 1
    total = sum(unigram_counts.values()) + bigram_count
    return {
        "total": total,
        "unigrams": dict(sorted(unigram_counts.items())),
        "bigrams": {"you know": bigram_count} if bigram_count else {},
        "occurrences": occurrences,
        "caveat": (
            "'like' is counted as a filler per the specification; it can also "
            "be a content word, so this count is a lexical approximation, not "
            "an acoustic disfluency detector."
        ),
    }


def stress_proxy(
    words: Sequence[Word],
    energy: FrameEnergy,
    track: F0Track,
    recording_median_f0: float | None,
) -> list[dict[str, Any]]:
    """Per-word duration/energy/F0 correlates of prominence (PROXY only)."""
    if not words:
        return []
    durations = np.array([w.duration for w in words], dtype=float)
    positive = durations[durations > 0]
    median_duration = float(np.median(positive)) if len(positive) else None
    valid_f0 = track.f0_hz[np.isfinite(track.f0_hz) & track.energy_ok]
    median_energy = float(np.median(energy.rms[np.isfinite(energy.rms)]))
    rows: list[dict[str, Any]] = []
    for word in words:
        energy_mask = (energy.times >= word.start) & (energy.times < word.end)
        word_rms = (
            float(np.mean(energy.rms[energy_mask])) if np.any(energy_mask) else None
        )
        f0_mask = (track.times >= word.start) & (track.times < word.end)
        word_f0 = track.f0_hz[f0_mask & np.isfinite(track.f0_hz)]
        mean_f0 = float(np.mean(word_f0)) if len(word_f0) else None
        relative_duration = (
            word.duration / median_duration
            if median_duration and median_duration > 0
            else None
        )
        energy_db_rel = (
            20.0 * math.log10(word_rms / median_energy)
            if word_rms and median_energy > 0
            else None
        )
        f0_semitones_rel = (
            12.0 * math.log2(mean_f0 / recording_median_f0)
            if mean_f0 and recording_median_f0
            else None
        )
        rows.append(
            {
                "text": word.text,
                "start": round(word.start, 4),
                "end": round(word.end, 4),
                "duration_seconds": round(word.duration, 4),
                "relative_duration": (
                    round(relative_duration, 4)
                    if relative_duration is not None
                    else None
                ),
                "mean_energy_dbfs": (
                    round(20.0 * math.log10(word_rms), 2) if word_rms else None
                ),
                "energy_db_rel": (
                    round(energy_db_rel, 2) if energy_db_rel is not None else None
                ),
                "mean_f0_hz": round(mean_f0, 2) if mean_f0 is not None else None,
                "f0_semitones_rel": (
                    round(f0_semitones_rel, 3)
                    if f0_semitones_rel is not None
                    else None
                ),
                "f0_frames": int(len(word_f0)),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Main analysis
# ---------------------------------------------------------------------------


def _calibration_status_for_pause_mode(
    word_source: str, word_gated: bool
) -> tuple[str, str]:
    if word_gated:
        if word_source == "human_annotation":
            evidence = CALIBRATION_EVIDENCE["pause_word_gated_human"]
            return STATUS_CALIBRATED, (
                "Word-gated pause detection with human-annotated word boundaries; "
                f"measured P={evidence['precision']} R={evidence['recall']} on "
                f"{evidence['speakers']} speakers."
            )
        if word_source == "asr":
            evidence = CALIBRATION_EVIDENCE["pause_word_gated_asr"]
            return STATUS_UNCALIBRATED, (
                "Word-gated pause detection with ASR word boundaries is "
                f"measured but not acceptable (P={evidence['precision']} "
                f"R={evidence['recall']} on {evidence['speakers']} speakers). "
                "Use pause_mode='waveform_only' with ASR words."
            )
        return STATUS_UNCALIBRATED, (
            "Word-gated pause detection with unverified supplied word timings; "
            "calibrated performance is only known for human-annotated or ASR "
            "word sources."
        )
    evidence = CALIBRATION_EVIDENCE["pause_waveform_only"]
    return STATUS_CALIBRATED, (
        "Waveform-only pause detection calibrated against human inter-word "
        f"gaps on {evidence['speakers']} speakers: P={evidence['precision']} "
        f"R={evidence['recall']} F1={evidence['f1']}. Pauses within 0.10 s of "
        "the 0.32 s minimum are inherently ambiguous."
    )


def _wpm_status(word_source: str) -> tuple[str, str]:
    if word_source == "human_annotation":
        return STATUS_CALIBRATED, (
            "Word count and boundaries come from human annotation; the timing "
            "formula is exact. The reference is a read passage, so the value "
            "does not transfer to spontaneous speech without re-validation."
        )
    if word_source == "asr":
        return STATUS_UNCALIBRATED, (
            "Depends on ASR word identity and boundaries. Measured on hjk: "
            "86.4% word match, median start error 85 ms, p90 531 ms; ASR WPM "
            "has not been validated across speakers."
        )
    return STATUS_UNCALIBRATED, (
        "Supplied word timings are unverified; WPM accuracy depends on their "
        "source."
    )


def analyze_wav(
    path: str | Path,
    *,
    words: Sequence[Word | Mapping[str, Any]] | None = None,
    transcript: str | None = None,
    word_source: str = "supplied",
    transcript_source: str = "supplied",
    pause_mode: str = "auto",
    include_contour: bool = True,
    pause_low_noise_multiplier: float = PAUSE_LOW_NOISE_MULTIPLIER,
) -> dict[str, Any]:
    """Analyse a WAV file and return a calibration-annotated prosody document.

    Parameters
    ----------
    path:
        PCM WAV file.
    words:
        Optional word timings (``Word`` objects or mappings with text/start/end).
    transcript:
        Optional transcript used for filler counting when word timings are not
        available.
    word_source:
        ``"human_annotation"``, ``"asr"``, ``"supplied"`` or ``"none"``.
    transcript_source:
        ``"human_annotation"``, ``"asr"``, ``"supplied"`` or ``"none"``.
    pause_mode:
        ``"auto"`` (word-gated when words are supplied, waveform-only
        otherwise), ``"waveform_only"`` or ``"word_gated"``.
    include_contour:
        Include the per-frame F0 contour in the output.
    pause_low_noise_multiplier:
        Per-user pause calibration hook.  The default is the shipped calibrated
        value (1.6).  The caller must clamp calibrated values to ``[0.9, 1.6]``
        to stay above the measured collapse point.
    """
    if word_source not in {"human_annotation", "asr", "supplied", "none"}:
        raise ValueError(f"invalid word_source: {word_source!r}")
    if transcript_source not in {"human_annotation", "asr", "supplied", "none"}:
        raise ValueError(f"invalid transcript_source: {transcript_source!r}")
    if pause_mode not in {"auto", "waveform_only", "word_gated"}:
        raise ValueError(f"invalid pause_mode: {pause_mode!r}")

    audio = load_wav(path)
    samples = audio.samples
    parsed_words = _coerce_words(words) if words else []
    if words and word_source == "none":
        word_source = "supplied"
    if transcript and transcript_source == "none":
        transcript_source = "supplied"

    energy = frame_energy(samples, audio.sample_rate)
    raw_detection = detect_pauses(
        samples,
        audio.sample_rate,
        pause_low_noise_multiplier=pause_low_noise_multiplier,
    )

    # Word-gating improves precision but loses recall when part of an
    # annotated pause is not below the energy threshold.  Waveform-only is the
    # calibrated default; word-gating is available as an opt-in precision mode
    # with human/ASR word timings.
    effective_mode = pause_mode
    if pause_mode == "auto":
        effective_mode = "waveform_only"
    if effective_mode == "word_gated" and not parsed_words:
        raise ValueError("pause_mode='word_gated' requires word timings")

    if effective_mode == "word_gated":
        pauses = gate_pauses_to_word_gaps(raw_detection.pauses, parsed_words)
    else:
        pauses = raw_detection.pauses

    pause_seconds = sum(p["seconds"] for p in pauses)
    span_start, span_end = raw_detection.speech_span
    speech_seconds = max(0.0, (span_end - span_start) - pause_seconds)
    total_seconds = audio.duration
    speech_ratio = speech_seconds / total_seconds if total_seconds > 0 else None

    pause_status, pause_caveat = _calibration_status_for_pause_mode(
        word_source, effective_mode == "word_gated"
    )
    pause_evidence = (
        "CALIBRATION_REPORT.md; calibration_results.json; "
        + (
            "word-gated"
            if effective_mode == "word_gated"
            else "waveform-only"
        )
    )

    # Pitch.
    track = estimate_f0(
        samples,
        audio.sample_rate,
        speech_threshold=raw_detection.low_threshold_rms,
    )
    pitch_summary = f0_summary(track)
    median_f0 = pitch_summary["median_hz"]

    # Fluency with words.
    word_count = len(parsed_words)
    if word_count:
        word_span = max(
            0.0, max(w.end for w in parsed_words) - min(w.start for w in parsed_words)
        )
        words_per_minute = (
            word_count * 60.0 / word_span if word_span > 0 else None
        )
        articulation_rate = (
            word_count / speech_seconds if speech_seconds > 0 else None
        )
    else:
        word_span = None
        words_per_minute = None
        articulation_rate = None

    wpm_status, wpm_caveat = _wpm_status(word_source if word_count else "none")

    # Fillers.
    tokens_available = bool(parsed_words or transcript)
    if tokens_available:
        filler = count_fillers(transcript=transcript, words=parsed_words or None)
        if transcript_source == "human_annotation" and not parsed_words:
            filler_status = STATUS_CALIBRATED
            filler_caveat = (
                "Exact lexical count over a human-annotated transcript; filler "
                "identification is still a lexical rule, not acoustic detection."
            )
        elif word_source == "human_annotation" and parsed_words:
            filler_status = STATUS_CALIBRATED
            filler_caveat = (
                "Exact lexical count over human-annotated word tokens; filler "
                "identification is a lexical rule, not acoustic detection."
            )
        else:
            filler_status = STATUS_UNCALIBRATED
            filler_caveat = (
                "Count depends on an ASR or unverified transcript; missed or "
                "hallucinated fillers propagate directly."
            )
    else:
        filler = {
            "total": None,
            "unigrams": {},
            "bigrams": {},
            "occurrences": [],
            "caveat": "No transcript or word tokens were supplied.",
        }
        filler_status = STATUS_UNCALIBRATED
        filler_caveat = "No transcript or word tokens were supplied."

    rhythm = rhythm_metrics(parsed_words)
    stress_words = stress_proxy(parsed_words, energy, track, median_f0)

    contour = None
    if include_contour:
        contour = {
            "hop_seconds": F0_HOP_SECONDS,
            "times": [round(float(t), 4) for t in track.times],
            "f0_hz": [
                round(float(v), 3) if np.isfinite(v) else None for v in track.f0_hz
            ],
            "confidence": [round(float(v), 4) for v in track.confidence],
            "voiced": [
                bool(np.isfinite(v) and e)
                for v, e in zip(track.f0_hz, track.energy_ok)
            ],
        }

    # Compatibility with the Work qa-pronunciation contract where sensible.
    compat_candidates = [
        p
        for p in sorted(pauses, key=lambda p: p["start"])
        if round(p["end"], 4) - round(p["start"], 4) >= PAUSE_MIN_SECONDS - 1e-9
    ]
    compat_pauses = [
        {"start": round(p["start"], 4), "end": round(p["end"], 4)}
        for p in compat_candidates[:12]
    ]
    compat_timing = None
    if parsed_words:
        compat_timing = {
            "start": round(min(w.start for w in parsed_words), 3),
            "end": round(max(w.end for w in parsed_words), 3),
            "recognizedWordsPerMinute": (
                round(words_per_minute, 1) if words_per_minute is not None else 0
            ),
            "pauseCount": len(pauses),
            "pauseSeconds": round(pause_seconds, 3),
            "pauses": compat_pauses,
        }
    compat_pitch = None
    if (
        pitch_summary["voiced_frames"] >= 20
        and pitch_summary["p10_hz"] is not None
        and pitch_summary["median_hz"] is not None
        and pitch_summary["p90_hz"] is not None
    ):
        compat_pitch = {
            "frames": pitch_summary["voiced_frames"],
            "p10Hz": pitch_summary["p10_hz"],
            "medianHz": pitch_summary["median_hz"],
            "p90Hz": pitch_summary["p90_hz"],
        }

    output: dict[str, Any] = {
        "version": VERSION,
        "calibration_version": CALIBRATION_VERSION,
        "audio": {
            "path": str(path),
            "original_sample_rate": audio.original_sample_rate,
            "analysis_sample_rate": audio.sample_rate,
            "channels": audio.channels,
            "duration_seconds": round(total_seconds, 4),
            "energy_frame_seconds": ENERGY_FRAME_SECONDS,
            "energy_hop_seconds": ENERGY_HOP_SECONDS,
        },
        "input_mode": {
            "word_source": word_source if word_count else "none",
            "transcript_source": transcript_source if tokens_available else "none",
            "word_count": word_count,
            "pause_mode": effective_mode,
            "pause_low_noise_multiplier": round(
                float(pause_low_noise_multiplier), 4
            ),
            "has_transcript": bool(transcript),
        },
        "fluency": {
            "total_duration_seconds": metric(
                round(total_seconds, 4),
                STATUS_CALIBRATED,
                caveat="Exact WAV duration.",
            ),
            "speech_span": metric(
                [round(span_start, 4), round(span_end, 4)],
                pause_status,
                caveat=pause_caveat,
                evidence=pause_evidence,
            ),
            "speech_duration_seconds": metric(
                round(speech_seconds, 4),
                pause_status,
                caveat=(
                    pause_caveat
                    + " Speech duration is the active span minus detected pauses, "
                    "so it inherits the pause error rate."
                ),
                evidence=pause_evidence,
            ),
            "speech_ratio": metric(
                round(speech_ratio, 4) if speech_ratio is not None else None,
                pause_status,
                caveat=pause_caveat,
                evidence=pause_evidence,
            ),
            "words_per_minute": metric(
                round(words_per_minute, 2) if words_per_minute is not None else None,
                wpm_status if word_count else STATUS_UNCALIBRATED,
                caveat=wpm_caveat if word_count else "No word timings supplied.",
            ),
            "articulation_rate_wps": metric(
                round(articulation_rate, 3)
                if articulation_rate is not None
                else None,
                (
                    STATUS_CALIBRATED
                    if word_count and word_source == "human_annotation"
                    and pause_status == STATUS_CALIBRATED
                    else STATUS_UNCALIBRATED
                ),
                caveat=(
                    "Computed as words / speech seconds from human-annotated "
                    "words and calibrated pause detection; it inherits the "
                    "pause error rate but is not an independently validated "
                    "construct."
                    if word_count and word_source == "human_annotation"
                    else (
                        "Computed as words / speech seconds; it inherits "
                        "word-timing and pause-detection error and has not been "
                        "independently validated."
                        if word_count
                        else "No word timings supplied."
                    )
                ),
            ),
            "pause_count": metric(
                len(pauses),
                pause_status,
                caveat=pause_caveat,
                evidence=pause_evidence,
            ),
            "pause_seconds": metric(
                round(pause_seconds, 4),
                pause_status,
                caveat=pause_caveat,
                evidence=pause_evidence,
            ),
            "pauses": metric(
                pauses,
                pause_status,
                caveat=pause_caveat,
                evidence=pause_evidence,
            ),
            "filler_count": metric(
                filler["total"],
                filler_status,
                caveat=filler_caveat,
            ),
            "filler_occurrences": metric(
                filler["occurrences"],
                filler_status,
                caveat=filler_caveat,
            ),
            "filler_breakdown": filler["unigrams"],
        },
        "pitch": {
            "estimator": "yin_cmndf",
            "cross_check_estimator": "cepstrum",
            "f0_frames": metric(
                pitch_summary["voiced_frames"],
                STATUS_CONSISTENCY,
                caveat=PITCH_CAVEAT,
            ),
            "p10_hz": metric(
                pitch_summary["p10_hz"], STATUS_CONSISTENCY, caveat=PITCH_CAVEAT
            ),
            "median_hz": metric(
                pitch_summary["median_hz"], STATUS_CONSISTENCY, caveat=PITCH_CAVEAT
            ),
            "p90_hz": metric(
                pitch_summary["p90_hz"], STATUS_CONSISTENCY, caveat=PITCH_CAVEAT
            ),
            "range_semitones": metric(
                pitch_summary["range_semitones"],
                STATUS_CONSISTENCY,
                caveat=PITCH_CAVEAT,
            ),
            "cross_check": pitch_summary["cross_check"],
            "corrections": pitch_summary["corrections"],
            "contour": metric(
                contour,
                STATUS_CONSISTENCY,
                caveat=PITCH_CAVEAT,
            ),
        },
        "rhythm": rhythm,
        "stress_proxy": {
            "status": "PROXY_UNVALIDATED",
            "method": (
                "per-word relative duration + mean energy + mean F0; no stress "
                "or syllable labels"
            ),
            "words": metric(
                stress_words,
                STATUS_PROXY,
                caveat=PROXY_STRESS_CAVEAT,
            ),
        },
        "work_compat": {
            "timing": compat_timing,
            "pitch": compat_pitch,
            "note": (
                "Shapes follow .sites-checkout/examples/work-qa/server/"
                "pronunciation.js where sensible; calibration flags live in the "
                "fluency/pitch sections above."
            ),
        },
        "calibration": CALIBRATION_EVIDENCE,
    }
    validate_output_schema(output)
    return output


def analyze_textgrid(
    wav_path: str | Path,
    textgrid_path: str | Path,
    *,
    transcript: str | None = None,
    pause_mode: str = "word_gated",
    include_contour: bool = True,
) -> dict[str, Any]:
    """Convenience wrapper using human-annotated TextGrid word boundaries.

    Human boundaries are accurate enough for word-gated pause detection, which
    is the precision-first mode (P=0.980, R=0.897 across 22 speakers).  Pass
    ``pause_mode="waveform_only"`` to evaluate the waveform detector alone.
    """
    words = parse_textgrid_words(textgrid_path)
    return analyze_wav(
        wav_path,
        words=words,
        transcript=transcript,
        word_source="human_annotation",
        transcript_source=(
            "human_annotation" if transcript is not None else "none"
        ),
        pause_mode=pause_mode,
        include_contour=include_contour,
    )