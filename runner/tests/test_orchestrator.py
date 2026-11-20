from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from runner.audio import AudioError, PreparedAudio
from runner.content_rules import Pronunciation
from runner.mcp_client import AuthError, ToolError
from runner.models import Feedback, ModelError
from runner.orchestrator import (
    HEARTBEAT_KEYS,
    AlreadyRunning,
    CoachRunner,
    RunnerConfig,
    StateStore,
    build_dry_run_runner,
    main,
    single_instance_lock,
)

RECORDING_ID = "9b2f6f2e-2a6c-4f1b-8a2d-0f8e5a5a5a5a"
RECORDING_BYTES = b"fake-audio-bytes"
RECORDING_SHA = hashlib.sha256(RECORDING_BYTES).hexdigest()


def text_attempt(attempt_id="v2:write:0:abc", **overrides):
    attempt = {
        "id": attempt_id,
        "day": 12,
        "stage": "write",
        "kind": "subjective",
        "status": "awaiting_coach",
        "title": "写作首稿",
        "response": "I go to school yesterday.",
        "conditions": "限时 20 分钟",
        "context": {"prompt": "Describe your day."},
    }
    attempt.update(overrides)
    return attempt


def speaking_attempt(**overrides):
    attempt = {
        "id": "v2:speak:0:abc",
        "day": 12,
        "stage": "speak",
        "kind": "subjective",
        "status": "awaiting_coach",
        "title": "口语 Part 2",
        "response": "I think this is fine.",
        "conditions": "已提交录音",
        "recordingId": RECORDING_ID,
        "recordingSha256": RECORDING_SHA,
        "context": {"prompt": "Describe a problem."},
    }
    attempt.update(overrides)
    return attempt


class FakeClient:
    def __init__(self, session, *, recording=RECORDING_BYTES):
        self.session = session
        self.recording = recording
        self.calls = []
        self.feedback_error = None
        self.read_error = None
        self.recording_calls = 0
        self.feedback_result = {"saved": True, "duplicate": False, "receiptId": "receipt-1"}

    def call_tool(self, name, arguments=None, *, client_run_id=None):
        arguments = dict(arguments or {})
        self.calls.append((name, arguments, client_run_id))
        if name == "report_scheduler_heartbeat":
            return {"ok": True}
        if name == "read_study_session":
            if self.read_error:
                raise self.read_error
            return copy.deepcopy(self.session)
        if name == "read_speaking_recording":
            self.recording_calls += 1
            offset = int(arguments["offset"])
            assert offset == 0
            return {
                "size": len(self.recording),
                "length": len(self.recording),
                "offset": 0,
                "nextOffset": None,
                "base64": __import__("base64").b64encode(self.recording).decode(),
                "sha256": RECORDING_SHA,
            }
        if name == "add_coach_feedback":
            if self.feedback_error:
                error, self.feedback_error = self.feedback_error, None
                raise error
            return dict(self.feedback_result)
        raise AssertionError(f"unexpected tool: {name}")

    def feedback_calls(self):
        return [arguments for name, arguments, _ in self.calls if name == "add_coach_feedback"]

    def heartbeats(self):
        return [
            arguments
            for name, arguments, _ in self.calls
            if name == "report_scheduler_heartbeat"
        ]


class FakeTextModel:
    provider = "fake"

    def __init__(self, *, error=None, feedback=None):
        self.error = error
        self.feedback = feedback

    def complete_text(self, snapshot):
        if self.error:
            error, self.error = self.error, None
            raise error
        if self.feedback is not None:
            return self.feedback(snapshot)
        return Feedback(
            feedback="把 “I go” 改成 “I went”，因为 yesterday 是过去时间。",
            evidence=f"原文写的是 “{snapshot['response']}”。",
            attempt=str(snapshot["id"]),
        )


class FakeAudioModel:
    provider = "fake"

    def __init__(self, *, error=None, with_pronunciation=True):
        self.error = error
        self.with_pronunciation = with_pronunciation
        self.audio_inputs = []

    def complete_audio(self, snapshot, audio):
        if self.error:
            error, self.error = self.error, None
            raise error
        self.audio_inputs.append(audio)
        return Feedback(
            feedback="注意 think 的 /θ/，下一次放慢一点。",
            evidence="录音中的 “think” 可以听清。",
            attempt=str(snapshot["id"]),
            pronunciation=(
                Pronunciation(band=6.5, observation="The /θ/ was audible.")
                if self.with_pronunciation
                else None
            ),
        )


def make_prepare(calls=None):
    calls = calls if calls is not None else []

    def prepare(raw, *, workdir, bitrates_kbps):
        calls.append({"raw": raw, "workdir": Path(workdir), "bitrates": tuple(bitrates_kbps)})
        return PreparedAudio(
            base64="QUJD",
            data_uri="data:;base64,QUJD",
            format="mp3",
            byte_length=3,
            encoded_length=4,
            duration_seconds=12.0,
            bitrate_kbps=64,
            sha256="0" * 64,
        )

    return prepare


def config(tmp_path, **overrides):
    values = {
        "state_dir": tmp_path / "state",
        "client_id": "client-id",
        "client_secret": "client-secret",
        "api_key": "sk-test",
        "daily_cap_cny": 20.0,
    }
    values.update(overrides)
    return RunnerConfig(**values)


def runner(tmp_path, session, *, model=None, client=None, prepare=None, **config_overrides):
    client = client or FakeClient(session)
    return (
        CoachRunner(
            config(tmp_path, **config_overrides),
            client=client,
            model=model or FakeTextModel(),
            prepare_audio=prepare or make_prepare(),
        ),
        client,
    )


def test_text_attempt_is_reviewed_and_saved(tmp_path):
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    coach, client = runner(tmp_path, session)
    report = coach.run()

    assert report.processed == 1
    assert report.failed == 0
    feedback = client.feedback_calls()[0]
    assert feedback["day"] == 12
    assert feedback["stage"] == "write"
    assert feedback["attempt"] == "v2:write:0:abc"
    assert "pronunciation" not in feedback
    assert "recordingId" not in feedback

    heartbeats = client.heartbeats()
    assert [item["status"] for item in heartbeats] == ["started", "finished"]
    for payload in heartbeats:
        # Optional None fields are omitted to match the server's optional-not-
        # nullable schema; required keys always present, no unknown keys.
        assert {"automationId", "generation", "clientRunId", "status"} <= set(payload) <= HEARTBEAT_KEYS
        assert payload["clientRunId"] == report.run_id
    assert heartbeats[-1]["detail"].startswith("processed=1")
    # Production track never claims a lease; the server claims internally.
    assert all(name != "claim_review_tasks" for name, _, _ in client.calls)


def test_only_pending_subjective_attempts_are_reviewed(tmp_path):
    session = {
        "day": 12,
        "reviewAttempts": [
            text_attempt("v2:write:0:abc"),
            text_attempt("v1:listen:0:def", stage="listen", status="answer_key_checked"),
            text_attempt("v2:write:1:ghi", status="reviewed"),
            text_attempt("v1:vocab:0:jkl", kind="objective"),
        ],
    }
    coach, client = runner(tmp_path, session)
    report = coach.run()
    assert report.processed == 1
    assert [call["attempt"] for call in client.feedback_calls()] == ["v2:write:0:abc"]


def test_audio_attempt_uses_recording_and_pronunciation(tmp_path):
    session = {"day": 12, "reviewAttempts": [speaking_attempt()]}
    model = FakeAudioModel()
    prepare_calls = []
    coach, client = runner(
        tmp_path, session, model=model, prepare=make_prepare(prepare_calls)
    )
    report = coach.run()

    assert report.processed == 1
    feedback = client.feedback_calls()[0]
    assert feedback["stage"] == "speak"
    assert feedback["recordingId"] == RECORDING_ID
    assert feedback["pronunciation"] == {
        "band": 6.5,
        "reviewedWholeClip": True,
        "observation": "The /θ/ was audible.",
    }
    read_call = next(
        arguments
        for name, arguments, _ in client.calls
        if name == "read_speaking_recording"
    )
    assert read_call["mode"] == "bytes"
    assert read_call["recordingId"] == RECORDING_ID
    assert prepare_calls[0]["raw"] == RECORDING_BYTES
    assert model.audio_inputs and model.audio_inputs[0].format == "mp3"


def test_duplicate_receipt_replay_is_accepted(tmp_path):
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    client = FakeClient(session)
    client.feedback_result = {
        "saved": True,
        "duplicate": True,
        "receiptId": "original-receipt",
    }
    coach, _ = runner(tmp_path, session, client=client)
    report = coach.run()
    assert report.processed == 1
    assert report.failed == 0
    assert len(client.feedback_calls()) == 1


def test_audio_without_pronunciation_is_retryable(tmp_path):
    session = {"day": 12, "reviewAttempts": [speaking_attempt()]}
    coach, client = runner(
        tmp_path,
        session,
        model=FakeAudioModel(with_pronunciation=False),
        prepare=make_prepare(),
    )
    report = coach.run()
    assert report.failed == 1
    assert client.feedback_calls() == []
    record = StateStore(tmp_path / "state" / "state.json").data["attempts"][
        "v2:speak:0:abc"
    ]
    assert record["blocked"] is False
    assert record["lastError"] == "pronunciation_missing"


def test_local_only_speaking_attempt_falls_back_to_text(tmp_path):
    session = {
        "day": 12,
        "reviewAttempts": [
            speaking_attempt(
                recordingId=None, localOnly=True, conditions="录音仅在原浏览器"
            )
        ],
    }
    coach, client = runner(tmp_path, session)
    report = coach.run()
    assert report.processed == 1
    feedback = client.feedback_calls()[0]
    assert "recordingId" not in feedback
    assert "pronunciation" not in feedback
    assert client.recording_calls == 0


def test_recording_sha_mismatch_blocks_attempt(tmp_path):
    session = {
        "day": 12,
        "reviewAttempts": [speaking_attempt(recordingSha256="0" * 64)],
    }
    prepare_calls = []
    coach, client = runner(tmp_path, session, prepare=make_prepare(prepare_calls))
    report = coach.run()
    assert report.failed == 1
    assert client.feedback_calls() == []
    assert prepare_calls == []
    assert StateStore(tmp_path / "state" / "state.json").is_blocked("v2:speak:0:abc")

    # A blocked attempt is not retried on the next run.
    report2 = coach.run()
    assert report2.skipped_blocked == 1
    assert client.feedback_calls() == []


def test_cost_cap_pauses_text_and_audio(tmp_path):
    session = {
        "day": 12,
        "reviewAttempts": [
            text_attempt("v2:write:0:abc"),
            text_attempt("v2:write:1:def"),
        ],
    }
    coach, client = runner(tmp_path, session, daily_cap_cny=0.06, text_cost_cny=0.05)
    report = coach.run()
    assert report.processed == 1
    assert report.paused is True
    assert report.detail == "cost_cap_paused"
    assert len(client.feedback_calls()) == 1
    final = client.heartbeats()[-1]
    assert final["status"] == "finished"
    assert final["detail"] == "cost_cap_paused"

    # Persisted pause: the next run does not even read the session.
    calls_before = len(client.calls)
    report2 = coach.run()
    assert report2.paused is True
    assert client.heartbeats()[-1]["detail"] == "cost_cap_paused"
    assert len(client.feedback_calls()) == 1
    assert not any(
        name == "read_study_session" for name, _, _ in client.calls[calls_before:]
    )


def test_transient_write_conflict_is_retried_not_blocked(tmp_path):
    """A learner re-submitting mid-review is self-healing, not a hard failure."""
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    client = FakeClient(session)
    client.feedback_error = ToolError(
        "Read study_session again and use the new exact attempt ID."
    )
    coach, _ = runner(tmp_path, session, client=client)
    report = coach.run()
    assert report.failed == 1
    record = StateStore(tmp_path / "state" / "state.json").data["attempts"]["v2:write:0:abc"]
    assert record["failures"] == 1
    assert record["blocked"] is False
    # The next run re-reads the session and succeeds.
    report2 = coach.run()
    assert report2.processed == 1


def test_transient_conflict_messages_are_classified_not_permanent(tmp_path):
    coach, _ = runner(tmp_path, {"day": 12, "reviewAttempts": []})
    assert coach._is_permanent(ToolError(
        "Read study_session again and use the new exact attempt ID.")) is False
    assert coach._is_permanent(ToolError("Another writer kept taking this review.")) is False
    assert coach._is_permanent(ToolError(
        "This exact submitted attempt is unavailable for the selected day and stage."
    )) is True


def test_error_details_are_redacted_before_logging_and_state():
    from runner.orchestrator import redact_error_detail
    detail = redact_error_detail("HTTPError: Authorization: Bearer sk-abc123 api_key=secret")
    assert "sk-abc123" not in detail and "secret" not in detail
    assert "REDACTED" in detail
    assert len(redact_error_detail("x" * 1000)) <= 300


def test_stale_lease_is_retried_next_round(tmp_path):
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    client = FakeClient(session)
    client.feedback_error = ToolError("stale", code="stale_lease")
    coach, _ = runner(tmp_path, session, client=client)
    report = coach.run()
    assert report.failed == 1
    state = StateStore(tmp_path / "state" / "state.json")
    record = state.data["attempts"]["v2:write:0:abc"]
    assert record["failures"] == 1
    assert record["blocked"] is False

    report2 = coach.run()
    assert report2.processed == 1
    assert "v2:write:0:abc" not in StateStore(
        tmp_path / "state" / "state.json"
    ).data["attempts"]


def test_retryable_model_error_is_not_blocked(tmp_path):
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    coach, client = runner(
        tmp_path,
        session,
        model=FakeTextModel(error=ModelError("model_unavailable", retryable=True)),
    )
    report = coach.run()
    assert report.failed == 1
    assert StateStore(tmp_path / "state" / "state.json").data["attempts"][
        "v2:write:0:abc"
    ]["blocked"] is False
    assert coach.run().processed == 1


def test_content_rule_failure_is_retryable(tmp_path):
    session = {"day": 12, "reviewAttempts": [text_attempt()]}

    def bad_feedback(snapshot):
        return Feedback(
            feedback="发音 6.5，问题不大。",
            evidence=f"原文 “{snapshot['response']}”。",
            attempt=str(snapshot["id"]),
        )

    coach, client = runner(tmp_path, session, model=FakeTextModel(feedback=bad_feedback))
    report = coach.run()
    assert report.failed == 1
    assert client.feedback_calls() == []
    record = StateStore(tmp_path / "state" / "state.json").data["attempts"][
        "v2:write:0:abc"
    ]
    assert record["blocked"] is False
    assert record["lastError"] == "pronunciation_score_from_text"


def test_permanent_audio_failure_blocks(tmp_path):
    session = {"day": 12, "reviewAttempts": [speaking_attempt()]}

    def too_long(raw, *, workdir, bitrates_kbps):
        raise AudioError("audio_too_long", retryable=False)

    coach, client = runner(
        tmp_path, session, model=FakeAudioModel(), prepare=too_long
    )
    report = coach.run()
    assert report.failed == 1
    assert StateStore(tmp_path / "state" / "state.json").is_blocked("v2:speak:0:abc")
    assert client.feedback_calls() == []


def test_auth_failure_is_fatal_with_failed_heartbeat(tmp_path):
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    client = FakeClient(session)
    client.read_error = AuthError("no service token")
    coach, _ = runner(tmp_path, session, client=client)
    report = coach.run()
    assert report.fatal is True
    assert report.detail == "auth_failed"
    assert client.heartbeats()[-1]["status"] == "failed"
    assert client.heartbeats()[-1]["detail"] == "auth_failed"


def test_single_instance_lock(tmp_path):
    lock = tmp_path / "runner.lock"
    with single_instance_lock(lock):
        with pytest.raises(AlreadyRunning):
            with single_instance_lock(lock):
                pass


def test_dry_run_uses_mocks_only(tmp_path):
    coach = build_dry_run_runner(tmp_path / "dry")
    report = coach.run()
    assert report.processed == 1
    assert report.failed == 0
    assert report.fatal is False


def test_cli_dry_run_smoke(tmp_path, capsys):
    assert main(["--dry-run", "--state-dir", str(tmp_path / "cli")]) == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["dryRun"] is True
    assert payload["processed"] == 1