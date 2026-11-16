"""Per-user pause-threshold calibration and T1 reliability disclosure.

Why this exists (design rev2 §4.6 / FIX-7 / FIX-29)
---------------------------------------------------
The shipped waveform pause detector uses ``PAUSE_LOW_NOISE_MULTIPLIER = 1.6``.
Its *macro* precision on the 22-speaker calibration corpus is 0.8124, but
per-speaker precision ranges from 0.333 to 1.000.  The production example that
asserted "36 pauses" was measured on a speaker whose precision is 0.650, so
roughly one in three of those pauses may be false.

The lead re-ran the headroom experiment with the authoritative matching rule
(overlap >= 50% of the reference OR midpoint within reference +/- 0.10 s) and
swept the multiplier *downward*::

    speaker  global 1.6  personal best  gain   optimal m
    njs      0.650      0.765          +0.115  1.4
    tni      0.640      0.750          +0.110  1.0
    aba      0.333      0.400          +0.067  1.2
    txhc     0.786      0.840          +0.054  1.4
    tlv/ykwk/zhaa already optimal      0.000  1.6
    mean gain +0.0494 (n=7)

Two honest limits are carried in every document this module produces:

* **Within-recording only.**  Each speaker contributed one recording.  The
  measured values are *headroom*, not cross-session generalisation.
* **Below ~0.8 the detector collapses** to zero detections.  The valid range is
  therefore clamped to ``[0.9, 1.6]`` and the collapse floor is enforced before
  any multiplier is returned.

The learner is deliberately conservative: fewer than ``MIN_LABELS`` verdicts
keeps the shipped default (1.6).  With enough verdicts it lowers the multiplier
only when even the Wilson 95% *upper* bound on the user's confirmed precision
is below ``TARGET_PRECISION`` (i.e. there is real evidence of low precision, not
merely a small sample).  This mirrors the direction of the measured headroom
(low-precision speakers benefit from a lower multiplier) without claiming that
the heuristic has been validated across sessions.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

# The measured sweep used 0.6..1.6.  Detections collapse below ~0.8; the
# conservative valid range starts at 0.9 so a calibration step can never fall
# into the collapse region.
VALID_MIN_MULTIPLIER = 0.9
VALID_MAX_MULTIPLIER = 1.6
COLLAPSE_FLOOR = 0.9
DEFAULT_MULTIPLIER = 1.6
MIN_LABELS = 5
TARGET_PRECISION = 0.85
WILSON_Z = 1.96

# Macro calibration evidence (``calibration_results.json`` /
# ``prosody.CALIBRATION_EVIDENCE["pause_waveform_only"]``).
POPULATION_MACRO_PRECISION = 0.8124
POPULATION_SPEAKER_PRECISION_RANGE = (0.333, 1.000)

WITHIN_RECORDING_CAVEAT = (
    "The multiplier headroom was measured within one recording per speaker; "
    "cross-session generalisation is unverified."
)

VALID_VERDICTS = frozenset({"confirmed", "rejected"})
MAX_STORED_VERDICTS_PER_USER = 500


def clamp_multiplier(value: float) -> float:
    """Clamp to the valid range and never below the measured collapse point."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_MULTIPLIER
    if not math.isfinite(number):
        return DEFAULT_MULTIPLIER
    return max(COLLAPSE_FLOOR, min(VALID_MAX_MULTIPLIER, number))


def wilson_interval(successes: int, trials: int, z: float = WILSON_Z) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion (stdlib only)."""
    if trials <= 0:
        return (0.0, 1.0)
    successes = max(0, min(int(successes), int(trials)))
    p = successes / trials
    denominator = 1.0 + z * z / trials
    centre = (p + z * z / (2.0 * trials)) / denominator
    half = (
        z
        * math.sqrt(p * (1.0 - p) / trials + z * z / (4.0 * trials * trials))
        / denominator
    )
    return (max(0.0, centre - half), min(1.0, centre + half))


@dataclass(frozen=True)
class PauseCalibrationState:
    """The per-user multiplier and the reliability estimate derived from it.

    ``multiplier`` is always inside ``[COLLAPSE_FLOOR, VALID_MAX_MULTIPLIER]``.
    ``source`` is one of ``default_insufficient_labels``, ``learned`` or
    ``supplied``.
    """

    user_id: str = "owner"
    multiplier: float = DEFAULT_MULTIPLIER
    source: str = "default_insufficient_labels"
    confirmations: int = 0
    rejections: int = 0
    labels: int = 0
    precision: float | None = None
    precision_ci: tuple[float, float] | None = None
    target_precision: float = TARGET_PRECISION
    valid_range: tuple[float, float] = (VALID_MIN_MULTIPLIER, VALID_MAX_MULTIPLIER)
    collapse_floor: float = COLLAPSE_FLOOR
    caveat: str = WITHIN_RECORDING_CAVEAT

    @property
    def calibrated(self) -> bool:
        return self.source == "learned" and self.labels >= MIN_LABELS

    @property
    def collapse_guarded(self) -> bool:
        return self.multiplier >= self.collapse_floor

    def to_document(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "multiplier": round(self.multiplier, 4),
            "multiplierSource": self.source,
            "validRange": list(self.valid_range),
            "collapseFloor": self.collapse_floor,
            "collapseGuarded": self.collapse_guarded,
            "labels": self.labels,
            "confirmations": self.confirmations,
            "rejections": self.rejections,
            "userPrecision": (
                round(self.precision, 4) if self.precision is not None else None
            ),
            "userPrecisionWilson95": (
                [round(v, 4) for v in self.precision_ci]
                if self.precision_ci is not None
                else None
            ),
            "populationMacroPrecision": POPULATION_MACRO_PRECISION,
            "populationSpeakerPrecisionRange": list(
                POPULATION_SPEAKER_PRECISION_RANGE
            ),
            "withinRecordingOnly": True,
            "caveat": self.caveat,
        }


def _verdict_label(value: Any) -> str | None:
    if isinstance(value, Mapping):
        value = value.get("verdict")
    label = str(value or "").strip().lower()
    return label if label in VALID_VERDICTS else None


def _normalise_verdicts(verdicts: Iterable[Any]) -> list[tuple[str, float]]:
    normalised: list[tuple[str, float]] = []
    for item in verdicts or ():
        label = _verdict_label(item)
        if label is None:
            continue
        raw_multiplier = None
        if isinstance(item, Mapping):
            raw_multiplier = item.get("multiplier")
        try:
            multiplier = (
                clamp_multiplier(float(raw_multiplier))
                if raw_multiplier is not None
                else DEFAULT_MULTIPLIER
            )
        except (TypeError, ValueError):
            multiplier = DEFAULT_MULTIPLIER
        normalised.append((label, multiplier))
    return normalised


def calibrate_pause_multiplier(
    verdicts: Sequence[Any] | None,
    *,
    user_id: str = "owner",
    default: float = DEFAULT_MULTIPLIER,
) -> PauseCalibrationState:
    """Derive a user-scoped multiplier from their pause confirmations.

    Fewer than ``MIN_LABELS`` usable labels keeps the shipped default.  With
    enough labels, the multiplier is lowered only when the Wilson *upper* bound
    on precision is below ``TARGET_PRECISION``; the movement is proportional to
    that gap and is clamped so it can never reach the measured collapse point.
    """
    default = clamp_multiplier(default)
    labels = _normalise_verdicts(verdicts or ())
    confirmations = sum(1 for label, _ in labels if label == "confirmed")
    rejections = sum(1 for label, _ in labels if label == "rejected")
    total = confirmations + rejections
    if total < MIN_LABELS:
        return PauseCalibrationState(
            user_id=user_id,
            multiplier=default,
            source="default_insufficient_labels",
            confirmations=confirmations,
            rejections=rejections,
            labels=total,
            precision=None,
            precision_ci=None,
        )

    precision = confirmations / total
    lower, upper = wilson_interval(confirmations, total)
    # Conservative direction: only lower the multiplier when even the
    # optimistic 95% upper bound on the user's precision is below target.
    # Using the lower bound here would lower the threshold for a user with
    # 5/5 confirmations simply because the sample is small, which is backwards.
    if upper >= TARGET_PRECISION:
        multiplier = default
    else:
        gap = TARGET_PRECISION - upper
        span = VALID_MAX_MULTIPLIER - VALID_MIN_MULTIPLIER
        estimate = VALID_MAX_MULTIPLIER - (gap / TARGET_PRECISION) * span
        multiplier = clamp_multiplier(estimate)
        # Rounding is applied after clamping so the collapse guard is exact.
        multiplier = round(multiplier, 2)

    return PauseCalibrationState(
        user_id=user_id,
        multiplier=min(default, multiplier),
        source="learned",
        confirmations=confirmations,
        rejections=rejections,
        labels=total,
        precision=precision,
        precision_ci=(lower, upper),
    )


def reliability_document(
    state: PauseCalibrationState,
    *,
    pause_count: int | None = None,
) -> dict[str, Any]:
    """Evidence-document view of the calibration and its reliability estimate."""
    document = state.to_document()
    document["pauseCountInThisRecording"] = (
        int(pause_count) if pause_count is not None else None
    )
    document["estimate"] = _estimate_label(state)
    return document


def _estimate_label(state: PauseCalibrationState) -> str:
    if state.calibrated and state.precision is not None:
        low, high = state.precision_ci or (0.0, 1.0)
        return (
            f"基于本人 {state.labels} 次停顿判断，精确率约 {state.precision:.2f}"
            f"（95% CI {low:.2f}–{high:.2f}）"
        )
    return (
        f"本人精确率尚未测量；总体精确率 {POPULATION_MACRO_PRECISION:.4f}，"
        f"逐用户范围 {POPULATION_SPEAKER_PRECISION_RANGE[0]:.3f}–"
        f"{POPULATION_SPEAKER_PRECISION_RANGE[1]:.3f}"
    )


def reliability_disclosure(
    state: PauseCalibrationState,
    *,
    pause_count: int | None = None,
) -> str:
    """Deterministic Chinese T1 disclosure appended to every grounded review."""
    prefix = (
        f"【T1 可靠性披露】本次停顿检测阈值倍数 {state.multiplier:.2f}"
        f"（来源：{state.source}）。{_estimate_label(state)}。"
    )
    if pause_count is not None:
        prefix += f"本次检测到 {int(pause_count)} 个停顿，该计数仅供参考，可能包含误检。"
    return (
        prefix
        + "阈值下调的收益是在同一段录音内测得的 headroom，尚未验证跨会话泛化。"
    )


class PauseCalibrationStore:
    """Small user-scoped verdict store under the runner state directory.

    The store is deliberately local and single-owner (design rev2 §0.4).  It
    never records audio or transcripts, only pause confirmations/rejections and
    the multiplier at which each item was shown.
    """

    SCHEMA = 1

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.data = self._load()

    def _empty(self) -> dict[str, Any]:
        return {"schema": self.SCHEMA, "users": {}}

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return self._empty()
        if not isinstance(value, dict) or value.get("schema") != self.SCHEMA:
            return self._empty()
        value.setdefault("users", {})
        if not isinstance(value["users"], dict):
            value["users"] = {}
        return value

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self.data, ensure_ascii=False, sort_keys=True), encoding="utf-8"
        )
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, self.path)

    def verdicts(self, user_id: str) -> list[dict[str, Any]]:
        record = self.data["users"].get(str(user_id)) or {}
        values = record.get("verdicts") if isinstance(record, Mapping) else None
        return [dict(item) for item in values or () if isinstance(item, Mapping)]

    def record(self, user_id: str, verdicts: Sequence[Any] | None) -> list[dict[str, Any]]:
        """Append normalised verdicts, deduplicated by ``candidateId``.

        A retry, double-click or replay therefore cannot inflate the sample.
        """
        user_key = str(user_id)
        record = self.data["users"].setdefault(user_key, {"verdicts": []})
        values = record.setdefault("verdicts", [])
        seen = {
            str(item.get("candidateId"))
            for item in values
            if isinstance(item, Mapping) and item.get("candidateId")
        }
        for item in verdicts or ():
            if not isinstance(item, Mapping):
                item = {"verdict": item}
            label = _verdict_label(item)
            if label is None:
                continue
            candidate_id = str(item.get("candidateId") or "").strip()
            if candidate_id and candidate_id in seen:
                continue
            if not candidate_id:
                # Without a server candidateId, derive a content hash so a
                # replayed identical verdict cannot inflate the sample.  The
                # server should supply candidateId for exact idempotency.
                material = json.dumps(
                    {
                        "verdict": label,
                        "multiplier": item.get("multiplier"),
                        "atMs": item.get("atMs"),
                        "pauseId": item.get("pauseId"),
                    },
                    sort_keys=True,
                )
                candidate_id = "anon-" + hashlib.sha256(
                    material.encode("utf-8")
                ).hexdigest()[:16]
            values.append(
                {
                    "candidateId": candidate_id,
                    "verdict": label,
                    "multiplier": (
                        clamp_multiplier(item.get("multiplier"))
                        if item.get("multiplier") is not None
                        else None
                    ),
                    "atMs": item.get("atMs"),
                }
            )
            seen.add(candidate_id)
        if len(values) > MAX_STORED_VERDICTS_PER_USER:
            del values[: len(values) - MAX_STORED_VERDICTS_PER_USER]
        return self.verdicts(user_key)

    def state(self, user_id: str, *, default: float = DEFAULT_MULTIPLIER) -> PauseCalibrationState:
        return calibrate_pause_multiplier(
            self.verdicts(user_id), user_id=str(user_id), default=default
        )