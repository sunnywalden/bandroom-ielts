"""Showing-policy-invariant progress metrics (design rev2 §7 / FIX-26).

The withdrawn metric was "posterior rising" and "rejection ratio rising".  Both
are confounded:

* a constant confirmer's posterior only ever rises;
* a learner who becomes more critical rejects more, which looks like "progress";
* the product chooses which classes to show, so the number of opportunities
  depends on the showing policy rather than on the learner.

The replacement is **candidate events of one class per minute of speech**, with
a Wilson confidence interval.  Counting occurrences and normalising by speech
time makes the value invariant to how often the product chose to show the class.
A change is only called progress after it is validated against an independent
measure; this module deliberately does not label a delta as "improvement".

Only stdlib is used so the orchestrator can import this without NumPy/SciPy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

WILSON_Z = 1.96

# Keys that belong to the withdrawn, confounded metrics.  Passing them is a
# programming error, not a value to be blended into the invariant metric.
CONFOUNDED_KEYS = frozenset(
    {
        "posterior",
        "posterior_mean",
        "posterior_delta",
        "rejection_ratio",
        "rejection_rate",
        "rejection_ratio_delta",
        "confirm_rate",
    }
)


class ProgressMetricError(ValueError):
    """Raised when a confounded or malformed progress metric is requested."""


def _wilson_interval(successes: int, trials: int, z: float = WILSON_Z) -> tuple[float, float]:
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
class ClassRate:
    class_key: str
    candidates: int
    speech_seconds: float
    rate_per_minute: float
    ci_low_per_minute: float
    ci_high_per_minute: float
    method: str = "candidate occurrences per minute of speech (Wilson 95% over seconds of exposure)"

    def to_document(self) -> dict[str, Any]:
        return {
            "classKey": self.class_key,
            "candidates": self.candidates,
            "speechSeconds": round(self.speech_seconds, 4),
            "ratePerMinute": round(self.rate_per_minute, 4),
            "ratePerMinuteWilson95": [
                round(self.ci_low_per_minute, 4),
                round(self.ci_high_per_minute, 4),
            ],
            "method": self.method,
            "showingPolicyInvariant": True,
        }


def per_class_candidate_rate(
    candidates: int,
    speech_seconds: float,
    *,
    class_key: str = "all",
) -> ClassRate:
    """Rate of candidate occurrences of one class per minute of speech.

    The Wilson interval treats each second of speech as an exposure unit with a
    candidate-present indicator.  This is a conservative approximation (it does
    not assume Poisson counts and cannot exceed one event per second); it is
    dependency-free and widens when speech time is short.
    """
    try:
        count = max(0, int(candidates))
    except (TypeError, ValueError) as exc:
        raise ProgressMetricError(f"candidates must be an integer: {candidates!r}") from exc
    try:
        seconds = float(speech_seconds)
    except (TypeError, ValueError) as exc:
        raise ProgressMetricError(
            f"speech_seconds must be numeric: {speech_seconds!r}"
        ) from exc
    if not math.isfinite(seconds) or seconds <= 0:
        raise ProgressMetricError("speech_seconds must be positive and finite")

    minutes = seconds / 60.0
    rate = count / minutes
    # A candidate can occur more than once per second in pathological input;
    # clamp the exposure trials so the proportion stays in [0, 1].
    trials = max(count, int(math.ceil(seconds)))
    low, high = _wilson_interval(count, trials)
    return ClassRate(
        class_key=str(class_key),
        candidates=count,
        speech_seconds=seconds,
        rate_per_minute=rate,
        ci_low_per_minute=low * 60.0,
        ci_high_per_minute=high * 60.0,
    )


def per_class_candidate_rates(
    observations: Iterable[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Aggregate per-class counts and speech exposure from occurrences.

    Each observation is ``{"class": "DH->D", "speechSeconds": 42.0}``.  The
    number of times the product *showed* the class (``shown``, ``nShown``) is
    irrelevant and is intentionally ignored; adding or removing it must not
    change the result.
    """
    counts: dict[str, int] = {}
    exposure: dict[str, float] = {}
    for item in observations or ():
        if not isinstance(item, Mapping):
            continue
        class_key = str(item.get("class") or item.get("classKey") or "").strip()
        if not class_key:
            continue
        counts[class_key] = counts.get(class_key, 0) + 1
        try:
            seconds = float(item.get("speechSeconds") or 0.0)
        except (TypeError, ValueError):
            seconds = 0.0
        # Use the largest exposure seen for the class so repeated occurrences in
        # the same recording do not multiply the denominator.
        exposure[class_key] = max(exposure.get(class_key, 0.0), seconds)

    result: dict[str, dict[str, Any]] = {}
    for class_key in sorted(counts):
        if exposure.get(class_key, 0.0) <= 0:
            result[class_key] = {
                "classKey": class_key,
                "candidates": counts[class_key],
                "ratePerMinute": None,
                "reason": "speech exposure missing or non-positive",
                "showingPolicyInvariant": True,
            }
            continue
        result[class_key] = per_class_candidate_rate(
            counts[class_key], exposure[class_key], class_key=class_key
        ).to_document()
    return result


def validate_progress_metric(metric: Mapping[str, Any]) -> None:
    """Reject the withdrawn confounded metrics and require an invariant field."""
    if not isinstance(metric, Mapping):
        raise ProgressMetricError("progress metric must be a mapping")
    confounded = sorted(CONFOUNDED_KEYS & {str(key) for key in metric})
    if confounded:
        raise ProgressMetricError(
            "confounded progress metric(s) not allowed: " + ", ".join(confounded)
        )
    if not (
        metric.get("showingPolicyInvariant") is True
        or {"ratePerMinute", "speechSeconds"} <= {str(key) for key in metric}
    ):
        raise ProgressMetricError(
            "progress metric must be showing-policy invariant "
            "(ratePerMinute + speechSeconds) and must not use posterior/rejection"
        )


def compare_rates(
    baseline: Mapping[str, Any], current: Mapping[str, Any]
) -> dict[str, Any]:
    """Describe a rate change without calling it progress.

    Returns the point delta and whether the two Wilson intervals overlap.  The
    caller must validate against an independent measure before using the word
    "progress" (design rev2 §7).
    """
    for name, value in (("baseline", baseline), ("current", current)):
        validate_progress_metric(value)
    base = float(baseline.get("ratePerMinute") or 0.0)
    curr = float(current.get("ratePerMinute") or 0.0)
    base_ci = baseline.get("ratePerMinuteWilson95") or [0.0, 0.0]
    curr_ci = current.get("ratePerMinuteWilson95") or [0.0, 0.0]
    overlap = max(float(base_ci[0]), float(curr_ci[0])) <= min(
        float(base_ci[1]), float(curr_ci[1])
    )
    return {
        "deltaPerMinute": round(curr - base, 4),
        "intervalsOverlap": overlap,
        "interpretation": (
            "rate change only; not validated as progress against an independent measure"
        ),
    }