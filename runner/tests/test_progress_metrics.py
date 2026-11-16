"""Showing-policy-invariant progress metric (FIX-26)."""

from __future__ import annotations

import pytest

from runner.progress_metrics import (
    ProgressMetricError,
    compare_rates,
    per_class_candidate_rate,
    per_class_candidate_rates,
    validate_progress_metric,
)


def test_rate_is_candidates_per_minute_of_speech():
    metric = per_class_candidate_rate(6, 120.0, class_key="DH->D")
    assert metric.candidates == 6
    assert metric.speech_seconds == 120.0
    assert metric.rate_per_minute == pytest.approx(3.0)
    document = metric.to_document()
    assert document["showingPolicyInvariant"] is True
    assert document["ratePerMinuteWilson95"][0] <= 3.0
    assert document["ratePerMinuteWilson95"][1] >= 3.0


def test_rate_widens_with_less_speech_exposure():
    short = per_class_candidate_rate(2, 30.0)
    long = per_class_candidate_rate(8, 120.0)
    assert short.rate_per_minute == pytest.approx(long.rate_per_minute)
    short_width = short.ci_high_per_minute - short.ci_low_per_minute
    long_width = long.ci_high_per_minute - long.ci_low_per_minute
    assert short_width > long_width


def test_rate_is_invariant_to_how_often_the_class_was_shown():
    base = [
        {"class": "DH->D", "speechSeconds": 60.0, "shown": 100, "nShown": 100},
        {"class": "DH->D", "speechSeconds": 60.0, "shown": 1, "nShown": 1},
    ]
    varied = [
        {"class": "DH->D", "speechSeconds": 60.0},
        {"class": "DH->D", "speechSeconds": 60.0},
    ]
    assert per_class_candidate_rates(base) == per_class_candidate_rates(varied)


def test_repeated_occurrences_do_not_multiply_speech_exposure():
    observations = [
        {"class": "DH->D", "speechSeconds": 60.0},
        {"class": "DH->D", "speechSeconds": 60.0},
    ]
    result = per_class_candidate_rates(observations)["DH->D"]
    # Two candidates in one minute of speech = 2/min, not 2 per 2 minutes.
    assert result["candidates"] == 2
    assert result["ratePerMinute"] == pytest.approx(2.0)


def test_confounded_metrics_are_rejected():
    for confounded in (
        {"posterior_delta": 0.2},
        {"rejection_ratio": 0.4},
        {"confirm_rate": 0.9},
    ):
        with pytest.raises(ProgressMetricError):
            validate_progress_metric(confounded)
    validate_progress_metric(
        {"ratePerMinute": 1.0, "speechSeconds": 60.0, "showingPolicyInvariant": True}
    )


def test_compare_rates_never_calls_a_delta_progress():
    base = per_class_candidate_rate(4, 120.0).to_document()
    current = per_class_candidate_rate(2, 120.0).to_document()
    comparison = compare_rates(base, current)
    assert comparison["deltaPerMinute"] == pytest.approx(-1.0)
    assert "not validated as progress" in comparison["interpretation"]


def test_invalid_inputs_fail_loudly():
    with pytest.raises(ProgressMetricError):
        per_class_candidate_rate(1, 0.0)
    with pytest.raises(ProgressMetricError):
        per_class_candidate_rate(1, float("nan"))