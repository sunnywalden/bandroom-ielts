"""Calibration transport: the runner must actually send groundedAnalysis.

Regression coverage for a defect found after the rev2 delivery was claimed
complete: the server accepted `groundedAnalysis` and issued candidateIds, but
`ValidatedFeedback` had no analysis field and `feedback_to_tool_args` never
emitted one, so production could never issue a single calibration candidate.
The personal-calibration loop was inert and V3 data could never accumulate.

Also covers the leak boundary: the phone pair travels to the server only, and
must never appear in learner-facing tier documents (a catch trial uses
expected === actual, so rendering the pair would distinguish it).
"""

from __future__ import annotations

import pytest

from runner import grounded_audio
from runner.content_rules import (
    ContentRuleError,
    coerce_grounded_analysis,
    feedback_to_tool_args,
    validate_feedback,
)
from runner.grounded_audio import (
    TierAssignment,
    TierItem,
    build_grounded_analysis,
    candidates_from_payload,
)
from runner.models.base import Feedback

ATTEMPT = "v1:speakingPart2:0:abc"
RECORDING = "a425fcde-aca6-4eb8-8898-8c7e76f07e66"


def payload_candidate(**over):
    base = {
        "word": "they",
        "expected": "DH",
        "actual": "D",
        "time": 5.21,
        "confidence": 0.91,
    }
    base.update(over)
    return base


def analysis_payload(**over):
    base = {
        "detectorVersion": "Haopeng/CROTTC-IF-l2-arctic@9149e51",
        "inventoryVersion": "arpabet-v1",
        "speechSeconds": 42.0,
        "candidates": [
            {
                "word": "they",
                "expected": "DH",
                "actual": "D",
                "atMs": 5210,
                "detectorConfidence": 0.91,
                "tier": "T3",
            }
        ],
    }
    base.update(over)
    return base


def validated(**over):
    kwargs = dict(
        expected_attempt=ATTEMPT,
        stage="speak",
        recording_id=RECORDING,
        audio_used=True,
        require_citation=False,
        analysis=analysis_payload(),
    )
    kwargs.update(over)
    return validate_feedback("反馈正文", "证据正文", ATTEMPT, **kwargs)


# --- the defect itself -----------------------------------------------------


def test_tool_args_carry_grounded_analysis():
    args = feedback_to_tool_args(
        validated(), day=12, stage="speak", recording_id=RECORDING, audio_used=True
    )
    assert "groundedAnalysis" in args, "runner must transport the calibration payload"
    assert args["recordingId"] == RECORDING
    assert args["groundedAnalysis"]["candidates"][0]["expected"] == "DH"


def test_feedback_model_accepts_analysis():
    fb = Feedback(
        feedback="正文", evidence="证据", attempt=ATTEMPT, analysis=analysis_payload()
    )
    assert fb.analysis is not None


def test_end_to_end_wiring_from_feedback_to_arguments():
    fb = Feedback(
        feedback="正文", evidence="证据", attempt=ATTEMPT, analysis=analysis_payload()
    )
    value = validate_feedback(
        fb.feedback,
        fb.evidence,
        fb.attempt,
        expected_attempt=ATTEMPT,
        stage="speak",
        recording_id=RECORDING,
        audio_used=True,
        require_citation=False,
        analysis=fb.analysis,
    )
    args = feedback_to_tool_args(
        value, day=12, stage="speak", recording_id=RECORDING, audio_used=True
    )
    assert args["groundedAnalysis"]["inventoryVersion"] == "arpabet-v1"


def test_text_review_never_carries_analysis():
    with pytest.raises(ContentRuleError):
        validated(stage="write")
    with pytest.raises(ContentRuleError):
        validated(recording_id=None)
    with pytest.raises(ContentRuleError):
        validated(audio_used=False)


def test_tool_args_reject_analysis_without_recording():
    value = validated()
    with pytest.raises(ContentRuleError):
        feedback_to_tool_args(value, day=12, stage="speak", recording_id=None, audio_used=True)


def test_absent_analysis_stays_absent():
    value = validated(analysis=None)
    args = feedback_to_tool_args(
        value, day=12, stage="speak", recording_id=RECORDING, audio_used=True
    )
    assert "groundedAnalysis" not in args


# --- schema bounds mirror the server --------------------------------------


@pytest.mark.parametrize(
    "mutation",
    [
        {"unknownField": 1},
        {"detectorVersion": ""},
        {"inventoryVersion": "x" * 81},
        {"speechSeconds": -1},
        {"speechSeconds": 10801},
        {"speechSeconds": True},
        {"candidates": []},
        {"candidates": [{}] * 25},
    ],
)
def test_invalid_payloads_rejected(mutation):
    payload = analysis_payload(**mutation)
    if mutation == {"candidates": []}:
        # An empty array is schema-valid; it just carries no evidence.
        assert coerce_grounded_analysis(payload)["candidates"] == []
        return
    with pytest.raises(ContentRuleError):
        coerce_grounded_analysis(payload)


@pytest.mark.parametrize(
    "candidate",
    [
        {"tier": "T1"},
        {"detectorConfidence": 1.5},
        {"detectorConfidence": -0.1},
        {"atMs": -1},
        {"atMs": 10800001},
        {"atMs": 1.5},
        {"expected": ""},
        {"actual": "TOOLONGPHONE"},
        {"word": "w" * 81},
        {"catchTrial": "yes"},
        {"candidateId": "server-issued-only"},
    ],
)
def test_invalid_candidates_rejected(candidate):
    base = analysis_payload()["candidates"][0]
    base.update(candidate)
    with pytest.raises(ContentRuleError):
        coerce_grounded_analysis(analysis_payload(candidates=[base]))


def test_runner_cannot_supply_candidate_ids():
    payload = analysis_payload()
    payload["candidates"][0]["candidateId"] = "forged"
    with pytest.raises(ContentRuleError):
        coerce_grounded_analysis(payload)


def test_feedback_model_rejects_bad_analysis():
    with pytest.raises(ContentRuleError):
        Feedback(feedback="x", evidence="y", attempt=ATTEMPT,
                 analysis=analysis_payload(speechSeconds=-5))


# --- detector payload keeps the phone pair --------------------------------


def test_candidates_from_payload_carries_phones():
    out = candidates_from_payload({"predictions": [payload_candidate()]}, max_n=3)
    assert out[0]["expected_phone"] == "DH"
    assert out[0]["actual_phone"] == "D"
    # The learner-facing suggestion text must not contain the pair.
    assert "DH" not in out[0]["suggestion_zh"]
    assert "D/" not in out[0]["suggestion_zh"]


def test_candidates_without_phones_still_work():
    raw = payload_candidate()
    del raw["expected"]
    del raw["actual"]
    out = candidates_from_payload({"predictions": [raw]}, max_n=3)
    assert "expected_phone" not in out[0]


# --- payload builder -------------------------------------------------------


def prosody(speech=42.0):
    return {"calibrated": {"speech_duration_seconds": speech}}


def raw_candidate(**over):
    base = {
        "word": "they",
        "timestamp_ms": 5210,
        "expected_phone": "DH",
        "actual_phone": "D",
        "detector_confidence": 0.91,
    }
    base.update(over)
    return base


def test_builder_produces_valid_payload():
    out = build_grounded_analysis([raw_candidate()], TierAssignment(), prosody())
    assert out is not None
    coerced = coerce_grounded_analysis(out)
    assert coerced["speechSeconds"] == 42.0
    assert coerced["candidates"][0]["tier"] == "T3"
    assert out["detectorVersion"] == grounded_audio.DETECTOR_RECOGNIZER
    assert len(out["detectorVersion"]) <= 80


def test_builder_marks_t2_from_assignment():
    item = TierItem(word="they", timestamp_ms=5210, seconds=5.21, tier="T2",
                    expected_phone="DH", actual_phone="D", provenance="history")
    out = build_grounded_analysis([raw_candidate()], TierAssignment(t2_items=(item,)), prosody())
    assert out["candidates"][0]["tier"] == "T2"


def test_builder_flags_catch_trial():
    out = build_grounded_analysis(
        [raw_candidate(actual_phone="DH")], TierAssignment(), prosody()
    )
    assert out["candidates"][0]["catchTrial"] is True


def test_builder_skips_incomplete_candidates():
    rows = [
        raw_candidate(expected_phone=""),
        raw_candidate(word=""),
        raw_candidate(timestamp_ms=0),
        raw_candidate(detector_confidence=None),
        raw_candidate(detector_confidence=2.0),
        raw_candidate(word="w" * 81),
    ]
    assert build_grounded_analysis(rows, TierAssignment(), prosody()) is None


def test_builder_caps_at_24():
    rows = [raw_candidate(timestamp_ms=1000 * (i + 1)) for i in range(40)]
    out = build_grounded_analysis(rows, TierAssignment(), prosody())
    assert len(out["candidates"]) == 24
    coerce_grounded_analysis(out)


def test_builder_handles_missing_prosody():
    out = build_grounded_analysis([raw_candidate()], TierAssignment(), {})
    assert out["speechSeconds"] == 0.0
    coerce_grounded_analysis(out)


def test_builder_empty_returns_none():
    assert build_grounded_analysis([], TierAssignment(), prosody()) is None


# --- leak boundary ---------------------------------------------------------


def test_tier_documents_stay_phone_free():
    """Raw candidates carry phones; rendered tier items must not."""
    rows = candidates_from_payload({"predictions": [payload_candidate()]}, max_n=3)
    assignment = grounded_audio.classify_candidates((), rows, phoneme_assertions_enabled=False)
    assert assignment.t2_items == ()
    for item in assignment.t3_items:
        doc = item.as_document()
        assert doc["expected_phone"] is None
        assert doc["actual_phone"] is None
        assert doc["is_error_assertion"] is False


def test_catch_trial_indistinguishable_in_tier_documents():
    normal = payload_candidate()
    catch = payload_candidate(word="the", expected="DH", actual="DH", time=9.0)
    rows = candidates_from_payload({"predictions": [normal, catch]}, max_n=3)
    assignment = grounded_audio.classify_candidates((), rows, phoneme_assertions_enabled=False)
    docs = [item.as_document() for item in assignment.t3_items]
    assert len(docs) == 2
    for doc in docs:
        assert doc["expected_phone"] is None and doc["actual_phone"] is None
    # Same shape, same keys: nothing marks the control item.
    assert set(docs[0]) == set(docs[1])


def test_disabling_assertions_strips_phones_from_downgraded_t2():
    asserted = [{
        "word": "they", "timestamp_ms": 5210, "expected_phone": "DH",
        "actual_phone": "D", "provenance": "history",
    }]
    assignment = grounded_audio.classify_candidates(asserted, (), phoneme_assertions_enabled=False)
    assert assignment.t2_items == ()
    assert assignment.downgraded
    for item in assignment.downgraded:
        assert item.expected_phone is None and item.actual_phone is None