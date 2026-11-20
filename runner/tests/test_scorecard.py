"""Scorecard contract tests: heuristics, quote traceability, honesty invariants."""
from typing import Any

import pytest

from runner import scorecard as sc

WORDS = [
    {"word": "I've", "start": 2.82, "end": 4.22, "probability": 0.62},
    {"word": "seen", "start": 4.22, "end": 4.52, "probability": 0.99},
    {"word": "a", "start": 4.52, "end": 6.16, "probability": 0.96},
    {"word": "short", "start": 6.16, "end": 7.16, "probability": 0.88},
    {"word": "video", "start": 7.16, "end": 7.8, "probability": 0.99},
]
TEXT = "I've seen a short video"
CAL = {
    "total_duration_seconds": 58.74,
    "speech_duration_seconds": 33.385,
    "speech_ratio": 0.5684,
    "pause_count": 22,
    "pause_seconds": 25.33,
    "pauses": [{"start": 10.0, "end": 11.5, "seconds": 1.5}],
}


def test_normalize_transcript_drops_malformed_and_bounds():
    raw = WORDS + [
        {"word": "", "start": 0, "end": 1},
        {"word": "bad", "start": 5, "end": 2},
        {"word": "neg", "start": -1, "end": 2},
        "not-a-mapping",
        {"word": "ok", "start": 8, "end": 9, "probability": 2.0},
    ]
    out = sc.normalize_transcript(raw)
    assert len(out) == len(WORDS) + 1
    assert out[-1]["probability"] == 0.0  # clamped, not trusted
    assert sc.normalize_transcript([{"word": f"w{i}", "start": i, "end": i + 1} for i in range(3000)]) == \
        sc.normalize_transcript([{"word": f"w{i}", "start": i, "end": i + 1} for i in range(3000)])[: sc.MAX_TRANSCRIPT_WORDS]


def test_fluency_card_calibrated_evidence_and_reference_band():
    card = sc.fluency_card(CAL, len(WORDS))
    assert card["status"] == sc.STATUS_REFERENCE
    assert card["evidence"]["metrics_status"] == sc.STATUS_CALIBRATED
    assert card["evidence"]["pace_status"] == "uncalibrated"
    # ratio 0.5684 -> base 6.5; long pauses 1.5/58.74 < 15% -> no penalty
    assert card["band"] == 6.5
    assert card["evidence"]["pace_wpm"] == pytest.approx(5 / 33.385 * 60, abs=0.1)


def test_fluency_long_pause_penalty_and_floor():
    cal = dict(CAL, speech_ratio=0.10, pauses=[{"seconds": 20.0}])
    card = sc.fluency_card(cal, 0)
    assert card["band"] == 3.5  # floor 4.0 - 0.5 penalty, clamped
    assert card["evidence"]["pace_wpm"] is None


def test_fluency_refuses_to_score_without_measurable_speech():
    # A broken instrument or a silent upload must NOT become a low band.
    assert sc.fluency_card({}, 0)["band"] is None
    silent = sc.fluency_card(dict(CAL, speech_duration_seconds=0.0, speech_ratio=0.0), 0)
    assert silent["band"] is None
    assert "不评分" in silent["disclosure_zh"]
    card = sc.build_scorecard(calibrated={}, words=[], llm=None, candidate_count=0)
    assert card["overall"]["band"] is None


def test_pronunciation_never_has_a_band():
    for n in (0, 3, 24):
        card = sc.pronunciation_card(n)
        assert card["band"] is None
        assert card["status"] == sc.STATUS_SUGGESTIVE


def test_grammar_and_lexical_bands_are_deterministic():
    g = sc.grammar_card([{"severity": "major"}, {"severity": "minor"}])
    assert g["band"] == 5.5  # 7 - 1 - 0.5
    assert sc.grammar_card([])["band"] == 7.0
    assert sc.grammar_card([{"severity": "major"}] * 10)["band"] == sc._BAND_MIN
    lex = sc.lexical_card(WORDS, [])
    assert lex["evidence"]["word_count"] == 5
    assert lex["band"] == 6.0  # too few words for diversity bonus


def test_issues_must_quote_transcript_verbatim():
    raw = [
        {"quote": "seen a short", "fix": "seen a brief", "reason_zh": "搭配", "severity": "minor"},
        {"quote": "SEEN   A SHORT", "fix": "x", "reason_zh": "y"},  # case/space ok
        {"quote": "a long video", "fix": "x", "reason_zh": "y"},  # fabricated -> dropped
        {"quote": "", "fix": "x"},
        {"quote": "seen", "fix": ""},  # empty fix -> dropped
    ]
    out = sc.validate_issues(raw, TEXT, kind="grammar")
    assert len(out) == 2
    assert out[0]["quote"] == "seen a short"


def test_drills_bounded_and_traceable():
    raw = [{"quote": TEXT, "improved": f"v{i}", "focus_zh": "练"} for i in range(6)]
    raw.append({"quote": "not in transcript", "improved": "x", "focus_zh": "y"})
    out = sc.validate_drills(raw, TEXT)
    assert len(out) == sc.MAX_DRILLS


def test_build_scorecard_full_and_degraded():
    llm = {
        "grammar_issues": [{"quote": "I've seen", "fix": "I saw", "reason_zh": "时态", "severity": "major"}],
        "lexical_issues": [],
        "drills": [{"quote": TEXT, "improved": "I watched a short clip.", "focus_zh": "过去时"}],
    }
    full = sc.build_scorecard(calibrated=CAL, words=WORDS, llm=llm, candidate_count=1)
    assert full["schema"] == sc.SCHEMA
    keys = [c["key"] for c in full["criteria"]]
    assert keys == ["fluency_coherence", "lexical_resource", "grammar", "pronunciation"]
    assert full["overall"]["band"] is not None
    assert full["overall"]["status"] == sc.STATUS_REFERENCE
    assert full["transcript"]["status"] == sc.STATUS_ASR
    assert len(full["drills"]) == 1
    assert full["llm_status"] == "ok"
    p = next(c for c in full["criteria"] if c["key"] == "pronunciation")
    assert p["band"] is None

    degraded = sc.build_scorecard(calibrated=CAL, words=[], llm=None, candidate_count=0)
    assert [c["key"] for c in degraded["criteria"]] == ["fluency_coherence", "pronunciation"]
    assert degraded["transcript"] is None
    assert degraded["llm_status"] == "unavailable"
    assert degraded["overall"]["basis_zh"] == "流利度与连贯性参考估计均值"


def test_overall_basis_names_the_scored_criteria_not_four():
    llm = {"grammar_issues": [], "lexical_issues": [], "drills": []}
    card = sc.build_scorecard(calibrated=CAL, words=WORDS, llm=llm, candidate_count=0)
    assert card["overall"]["basis_zh"] == "流利度与连贯性、词汇、语法参考估计均值"
    # FC refused (no measurable speech) while a transcript exists: the label
    # must say what WAS averaged and that fluency was excluded.
    refused = sc.build_scorecard(calibrated={}, words=WORDS, llm=llm, candidate_count=0)
    assert "流利度" not in refused["overall"]["basis_zh"].split("（")[0]
    assert "本次未测得可用语音，流利度不参与" in refused["overall"]["basis_zh"]


def test_long_transcript_card_stays_under_transport_cap():
    many = [{"word": f"w{i}", "start": i * 0.3, "end": i * 0.3 + 0.2, "probability": 0.9} for i in range(2000)]
    card = sc.build_scorecard(calibrated=CAL, words=many, llm=None, candidate_count=0)
    import json
    assert len(json.dumps(card, ensure_ascii=False)) < 65536, "the card must fit the 64 KiB coercion cap"
    assert "words" not in (card["transcript"] or {})


def test_fabricated_llm_issues_never_reach_scorecard():
    llm = {"grammar_issues": [{"quote": "completely invented words", "fix": "x", "severity": "major"}]}
    card = sc.build_scorecard(calibrated=CAL, words=WORDS, llm=llm, candidate_count=0)
    g = next(c for c in card["criteria"] if c["key"] == "grammar")
    assert g["evidence"]["error_count"] == 0
    assert g["band"] == 7.0


def test_parse_scorecard_llm_fences_and_bad_shape():
    assert sc.parse_scorecard_llm('```json\n{"grammar_issues": []}\n```') == {"grammar_issues": []}
    with pytest.raises(ValueError):
        sc.parse_scorecard_llm("[]")
    with pytest.raises(Exception):
        sc.parse_scorecard_llm("not json")


def test_prompt_carries_transcript_and_forbids_pronunciation():
    system, user = sc.build_scorecard_prompt(WORDS, CAL, learner_draft="draft")
    assert TEXT in user
    assert "不评发音" in system
    assert "逐字" in system


def _payload(**extra):
    base = {
        "detectorVersion": "crottc-test", "inventoryVersion": "arpabet-v1",
        "speechSeconds": 33.4, "candidates": [],
    }
    base.update(extra)
    return base


def test_transport_coercion_accepts_transcript_and_scorecard():
    from runner.content_rules import coerce_grounded_analysis

    card = sc.build_scorecard(calibrated=CAL, words=WORDS, llm=None, candidate_count=0)
    out = coerce_grounded_analysis(_payload(transcript=WORDS, scorecard=card))
    assert out["transcript"][0]["word"] == "I've"
    assert out["scorecard"]["schema"] == sc.SCHEMA


def test_drill_tts_enrichment_fail_closed():
    from runner.contrast_audio import enrich_drills

    drills: list[dict[str, Any]] = [{"quote": TEXT, "improved": "I watched a short clip.", "focus_zh": "练"}]
    # Disabled: no network, no contrast key.
    summary = enrich_drills(drills, enabled=False)
    assert summary["attempted"] == 0
    assert "contrast_audio" not in drills[0]
    # Enabled without key: fail closed before any call.
    summary = enrich_drills(drills, enabled=True, api_key="")
    assert summary["unavailable"] == 1
    assert drills[0]["contrast_audio"]["status"] == "unavailable"

    def transport(body, headers, timeout):
        assert body["input"]["text"] == "I watched a short clip."
        return {"output": {"audio": {"url": "https://tts.example/a.mp3", "id": "a1"}}}

    summary = enrich_drills(drills, enabled=True, transport=transport, api_key="k")
    assert summary["succeeded"] == 1
    assert drills[0]["contrast_audio"]["url"] == "https://tts.example/a.mp3"

    def broken(body, headers, timeout):
        raise RuntimeError("tts down")

    summary = enrich_drills(drills, enabled=True, transport=broken, api_key="k")
    assert summary["unavailable"] == 1
    assert drills[0]["contrast_audio"]["status"] == "unavailable"


def test_transport_rejects_pronunciation_band_and_bad_shape():
    from runner.content_rules import coerce_grounded_analysis, ContentRuleError

    card = sc.build_scorecard(calibrated=CAL, words=WORDS, llm=None, candidate_count=0)
    for c in card["criteria"]:
        if c["key"] == "pronunciation":
            c["band"] = 6.0  # forbidden: assertion gates unmet
    with pytest.raises(ContentRuleError):
        coerce_grounded_analysis(_payload(scorecard=card))
    with pytest.raises(ContentRuleError):
        coerce_grounded_analysis(_payload(transcript=[{"word": "x", "start": 5, "end": 2, "probability": 0.5}]))
    with pytest.raises(ContentRuleError):
        coerce_grounded_analysis(_payload(scorecard={"schema": "unknown"}))
