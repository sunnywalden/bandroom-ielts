"""Catch-trial generation and the constant-confirmer control.

The frozen V3 gate requires catch trials to be present and labelled, but the
detector only ever emits substitutions (expected != actual), so a control could
never appear naturally. Without generation the gate is unmeetable no matter how
much real data accumulates.

A control must come from an UNFLAGGED word: built from a flagged word it would be
confounded, because the learner could correctly hear a real error and confirm.
"""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace

import pytest

from runner import grounded_audio
from runner.content_rules import coerce_grounded_analysis
from runner.grounded_audio import (
    FROZEN_DETECTOR_SHA256,
    TierAssignment,
    build_grounded_analysis,
    detector_cache_path,
    select_catch_trial,
)


def sha_for_catch() -> str:
    """Find an audio sha whose deterministic cadence selects a control."""
    for i in range(200):
        candidate = hashlib.sha256(f"audio-{i}".encode()).hexdigest()
        digest = hashlib.sha256(f"catch|{candidate}".encode()).hexdigest()
        if int(digest[:8], 16) % grounded_audio.CATCH_TRIAL_MODULUS == 0:
            return candidate
    raise AssertionError("no cadence-selected sha found")


def sha_without_catch() -> str:
    for i in range(200):
        candidate = hashlib.sha256(f"audio-{i}".encode()).hexdigest()
        digest = hashlib.sha256(f"catch|{candidate}".encode()).hexdigest()
        if int(digest[:8], 16) % grounded_audio.CATCH_TRIAL_MODULUS != 0:
            return candidate
    raise AssertionError("no cadence-excluded sha found")


def write_cache(tmp_path, audio_sha, words, *, script_sha=FROZEN_DETECTOR_SHA256):
    grounded = SimpleNamespace(detector_cache_dir=str(tmp_path))
    path = detector_cache_path(audio_sha, tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "detectorScriptSha256": script_sha,
        "sourceSha256": audio_sha,
        "words": words,
        "predictions": [],
    }))
    return grounded


def word(text, start, end, probability=0.97):
    return {"word": f" {text}", "start": start, "end": end, "probability": probability}


WORDS = [word("tom", 0.7, 1.5), word("had", 1.5, 2.9), word("a", 2.9, 3.2),
         word("business", 3.2, 4.4), word("trip", 4.4, 5.3), word("last", 5.3, 6.2)]


def test_control_selected_from_unflagged_word(tmp_path):
    sha = sha_for_catch()
    grounded = write_cache(tmp_path, sha, WORDS)
    control = select_catch_trial(sha, grounded, ["business"])
    assert control is not None
    assert control["word"] != "business"
    assert control["catch_trial"] is True
    assert control["expected_phone"] == control["actual_phone"]


def test_control_never_uses_a_flagged_word(tmp_path):
    sha = sha_for_catch()
    grounded = write_cache(tmp_path, sha, WORDS)
    flagged = [w["word"].strip() for w in WORDS]
    assert select_catch_trial(sha, grounded, flagged) is None


def test_cadence_is_deterministic(tmp_path):
    sha = sha_for_catch()
    grounded = write_cache(tmp_path, sha, WORDS)
    first = select_catch_trial(sha, grounded, ["business"])
    second = select_catch_trial(sha, grounded, ["business"])
    assert first == second
    other = sha_without_catch()
    write_cache(tmp_path, other, WORDS)
    assert select_catch_trial(other, grounded, ["business"]) is None


def test_low_asr_confidence_words_excluded(tmp_path):
    sha = sha_for_catch()
    quiet = [word("tom", 0.7, 1.5), word("mumble", 1.5, 2.9, probability=0.4),
             word("end", 2.9, 3.5)]
    grounded = write_cache(tmp_path, sha, quiet)
    control = select_catch_trial(sha, grounded, [])
    assert control is None or control["word"] != "mumble"


def test_too_short_words_excluded(tmp_path):
    sha = sha_for_catch()
    tiny = [word("tom", 0.7, 1.5), word("a", 1.5, 1.55), word("end", 2.9, 3.5)]
    grounded = write_cache(tmp_path, sha, tiny)
    control = select_catch_trial(sha, grounded, [])
    assert control is None or control["word"] != "a"


def test_wrong_script_sha_rejected(tmp_path):
    sha = sha_for_catch()
    grounded = write_cache(tmp_path, sha, WORDS, script_sha="0" * 64)
    assert select_catch_trial(sha, grounded, []) is None


def test_missing_cache_returns_none(tmp_path):
    grounded = SimpleNamespace(detector_cache_dir=str(tmp_path))
    assert select_catch_trial(sha_for_catch(), grounded, []) is None


def test_control_enters_payload_and_stays_schema_valid():
    control = {"word": "trip", "timestamp_ms": 4400, "detector_confidence": 0.97,
               "expected_phone": "AH", "actual_phone": "AH", "catch_trial": True}
    payload = build_grounded_analysis([], TierAssignment(), {}, catch_trial=control)
    assert payload is not None
    coerced = coerce_grounded_analysis(payload)
    assert len(coerced["candidates"]) == 1
    item = coerced["candidates"][0]
    assert item["catchTrial"] is True
    assert item["expected"] == item["actual"]
    assert item["tier"] == "T3"


def test_control_respects_the_24_candidate_bound():
    rows = [{"word": "they", "timestamp_ms": 1000 * (i + 1), "expected_phone": "DH",
             "actual_phone": "D", "detector_confidence": 0.9} for i in range(40)]
    control = {"word": "trip", "timestamp_ms": 99000, "detector_confidence": 0.97,
               "expected_phone": "AH", "actual_phone": "AH", "catch_trial": True}
    payload = build_grounded_analysis(rows, TierAssignment(), {}, catch_trial=control)
    assert len(payload["candidates"]) == 24
    assert payload["candidates"][-1]["catchTrial"] is True
    coerce_grounded_analysis(payload)


def test_non_identical_pair_is_not_a_control():
    bad = {"word": "trip", "timestamp_ms": 4400, "detector_confidence": 0.97,
           "expected_phone": "AH", "actual_phone": "D", "catch_trial": True}
    payload = build_grounded_analysis([], TierAssignment(), {}, catch_trial=bad)
    assert payload is None


def test_control_does_not_leak_into_rendered_tier_items():
    """The control lives in the payload only; prose tier items stay phone-free."""
    rows = grounded_audio.candidates_from_payload(
        {"predictions": [{"word": "they", "expected": "DH", "actual": "D",
                          "time": 5.21, "confidence": 0.9}]}, max_n=3)
    assignment = grounded_audio.classify_candidates((), rows, phoneme_assertions_enabled=False)
    control = {"word": "trip", "timestamp_ms": 4400, "detector_confidence": 0.97,
               "expected_phone": "AH", "actual_phone": "AH", "catch_trial": True}
    payload = build_grounded_analysis(rows, assignment, {}, catch_trial=control)
    assert len(payload["candidates"]) == 2
    for item in assignment.t3_items:
        doc = item.as_document()
        assert doc["expected_phone"] is None and doc["actual_phone"] is None
    # The control is indistinguishable in shape from a real candidate.
    real, ctrl = payload["candidates"]
    assert set(real) | {"catchTrial"} == set(ctrl)