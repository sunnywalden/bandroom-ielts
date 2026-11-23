"""Phase 1 writing issue cards on the runner: prompt routing, local parsing
checks, prose fallback and the queue completion payload."""
from __future__ import annotations

import json

import pytest

from runner import writing_cards as wc
from runner.tests.test_orchestrator import FakeTextModel
from runner.tests.test_orchestrator_multitenant import FakeQueueClient, mt_runner

DRAFT = "Nowadays many people believes that cities are crowded. It is good for society."


def write_attempt(field="writeOriginal", response=DRAFT, context=None, attempt_id="v2:w1"):
    return {
        "id": attempt_id, "day": 12, "field": field, "index": 0, "stage": "write",
        "title": "写作", "kind": "subjective", "response": response, "conditions": "",
        "evidence": "", "context": context or {"prompt": "Discuss cities."},
    }


CARDS = {
    "attempt": "v2:w1", "mode": "cards",
    "issues": [
        {"id": "i1", "category": "GRA", "priority": "must", "quote": "people believes",
         "prompt_zh": "主语是复数，谓语要怎么变？", "why_zh": "people 为复数。", "suggestion": "people believe"},
        {"id": "i2", "category": "TR", "priority": "should", "quote": "It is good for society.",
         "prompt_zh": "“好”体现在哪里？", "why_zh": "缺少例子。", "suggestion": "rewrite me"},
    ],
    "summary": {"priorities": ["i1", "i2"], "next_step_zh": "每个论点后补一个具体例子。"},
}


def test_routing_cards_vs_delta():
    assert wc.is_writing_attempt(write_attempt())
    assert not wc.is_writing_attempt({**write_attempt(), "stage": "speak"})
    assert not wc.is_writing_attempt({**write_attempt(), "field": "vocabUse"})
    assert wc.review_mode(write_attempt()) == "cards"
    self_directed = write_attempt("writeRevision", context={"prompt": "p", "firstDraft": DRAFT})
    assert wc.review_mode(self_directed) == "cards"
    delta = write_attempt("writeRevision", context={
        "prompt": "p", "firstDraft": DRAFT,
        "firstReview": {"feedbackId": "rt:1", "issues": [{"id": "i1", "quote": "people believes"}]},
    })
    assert wc.review_mode(delta) == "delta"
    mode, system, user = wc.build_messages(delta)
    assert mode == "delta" and "SECOND draft" in system and wc.WRITING_PROMPT_VERSION in system
    payload = json.loads(user.split('<learner_data untrusted="true">\n')[1].split("\n</learner_data>")[0])
    assert payload["firstDraft"] == DRAFT and payload["firstDraftIssues"][0]["id"] == "i1"
    assert "untrusted" in user


def test_parse_cards_composes_cited_text_and_strips_argument_rewrites():
    review = wc.parse_review(json.dumps(CARDS), write_attempt(), "cards")
    assert review.mode == "cards"
    assert review.writing["issues"][1]["suggestion"] is None
    assert "“people believes”" in review.evidence
    assert review.feedback.startswith("【语法·必改】“people believes”")


@pytest.mark.parametrize("mutate,code", [
    (lambda d: d.update(attempt="v2:other"), "attempt_mismatch"),
    (lambda d: d["summary"].update(next_step_zh="这篇作文 band 6.5"), "uncalibrated_band"),
    (lambda d: d.update(issues=[]), "invalid_writing"),
    (lambda d: [i.update(quote="not in the draft at all") for i in d["issues"]], "unanchored_writing"),
    (lambda d: d["issues"][0].update(category="XX"), "invalid_writing"),
])
def test_parse_cards_rejections(mutate, code):
    data = json.loads(json.dumps(CARDS))
    mutate(data)
    with pytest.raises(wc.WritingCardError) as info:
        wc.parse_review(json.dumps(data), write_attempt(), "cards")
    assert info.value.code == code


def test_parse_rejects_non_json():
    with pytest.raises(wc.WritingCardError) as info:
        wc.parse_review("not json", write_attempt(), "cards")
    assert info.value.code == "model_bad_json"


def test_parse_delta():
    revision = DRAFT.replace("people believes", "people believe")
    attempt = write_attempt("writeRevision", response=revision, attempt_id="v2:w2")
    raw = {"attempt": "v2:w2", "mode": "delta",
           "verdicts": [{"issue": "i1", "result": "resolved", "evidence_quote": "people believe that", "why_zh": "已改正。"}],
           "issues": [], "summary": {"carry_forward_zh": "检查主谓一致。"}}
    review = wc.parse_review(json.dumps(raw), attempt, "delta")
    assert review.writing["verdicts"][0]["result"] == "resolved"
    assert "“people believe that”" in review.evidence
    assert "下次带走" in review.feedback


class WritingModel(FakeTextModel):
    def __init__(self, raw):
        super().__init__()
        self.raw = raw
        self.writing_calls = 0

    def complete_writing(self, system, user, *, timeout=None):
        self.writing_calls += 1
        return self.raw


def _write_task(task_id="t-w", attempt=None):
    return {
        "id": task_id, "userId": "u1", "kind": "text", "day": 12, "fence": 0,
        "state": "queued", "next_at": 0, "lease_until": 0, "analysisVersion": None,
        "recordingId": None, "snapshot": {"attempt": attempt or write_attempt(attempt_id="v2:w1")},
    }


def test_queue_completes_writing_with_structured_cards(tmp_path):
    client = FakeQueueClient([_write_task()])
    model = WritingModel(json.dumps(CARDS))
    runner = mt_runner(tmp_path, client, model=model)
    report = runner.run()
    assert report.processed == 1
    assert model.writing_calls == 1
    args = client.completed[0]
    assert args["writing"]["mode"] == "cards"
    assert args["writing"]["issues"][0]["quote"] == "people believes"
    assert "“people believes”" in args["evidence"]


def test_queue_falls_back_to_prose_on_bad_writing_json(tmp_path):
    client = FakeQueueClient([_write_task()])
    model = WritingModel("{broken")
    runner = mt_runner(tmp_path, client, model=model)
    report = runner.run()
    assert report.processed == 1
    args = client.completed[0]
    assert "writing" not in args, "fallback is the established prose review"
    assert args["feedback"].startswith("把 “I go”")


def test_queue_non_writing_text_unchanged(tmp_path):
    attempt = {**write_attempt(), "field": "vocabUse", "stage": "vocab"}
    client = FakeQueueClient([_write_task(attempt=attempt)])
    model = WritingModel(json.dumps(CARDS))
    report = mt_runner(tmp_path, client, model=model).run()
    assert report.processed == 1
    assert model.writing_calls == 0
    assert "writing" not in client.completed[0]


def recheck_attempt(response="Nowadays many people believe that cities are crowded."):
    return {
        "id": "v2:rc1", "day": 12, "field": "writeRecheck", "index": 0, "stage": "write",
        "title": "单项快检", "kind": "subjective", "response": response, "conditions": "", "evidence": "",
        "context": {"baseFeedbackId": "rt:1", "issue": {"id": "i1", "category": "GRA", "quote": "people believes"},
                    "originalSnippet": DRAFT, "learnerWhy": "people 是复数"},
    }


def test_recheck_messages_and_parse():
    attempt = recheck_attempt()
    assert wc.is_recheck_attempt(attempt) and not wc.is_writing_attempt(attempt)
    system, user = wc.build_recheck_messages(attempt)
    assert "ONE quick check" in system and "people 是复数" in user
    review = wc.parse_recheck(json.dumps({"attempt": "v2:rc1", "mode": "recheck", "result": "resolved",
                                          "evidence_quote": "people believe that", "why_zh": "已改正。"}), attempt)
    assert review.writing == {"mode": "recheck", "result": "resolved", "evidence_quote": "people believe that", "why_zh": "已改正。"}
    assert "“people believe that”" in review.evidence
    with pytest.raises(wc.WritingCardError):
        wc.parse_recheck(json.dumps({"attempt": "v2:rc1", "result": "perfect", "why_zh": "x"}), attempt)
    with pytest.raises(wc.WritingCardError):
        wc.parse_recheck(json.dumps({"attempt": "v2:rc1", "result": "resolved", "why_zh": "写作 band 7"}), attempt)


def test_queue_completes_recheck_without_prose_fallback(tmp_path):
    raw = json.dumps({"attempt": "v2:rc1", "mode": "recheck", "result": "partial",
                      "evidence_quote": "people believe", "why_zh": "主谓一致对了。"})
    client = FakeQueueClient([_write_task("t-rc", attempt=recheck_attempt())])
    model = WritingModel(raw)
    assert mt_runner(tmp_path, client, model=model).run().processed == 1
    assert client.completed[0]["writing"]["mode"] == "recheck"
    bad = FakeQueueClient([_write_task("t-rc2", attempt=recheck_attempt())])
    report = mt_runner(tmp_path / "b", bad, model=WritingModel("{nope")).run()
    assert report.processed == 0 and not bad.completed, "a malformed quick check is never shown as prose"
