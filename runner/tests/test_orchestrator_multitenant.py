"""P2b orchestrator queue wiring (iteration-30 plan §8).

Covers: complete_review_task end-to-end (text + grounded), per-user budget skip,
lease renewal during a long call, single-owner regression, missing tenant fields,
two-user fairness batch cap, the fail-closed speaking release-gate gap, and the
global cap pausing the run. The fake client mirrors the server queue semantics
(claim increments fence; retryable fail defers next_at; non-retryable blocks).
"""
from __future__ import annotations

import base64
import time

import pytest

from runner import grounded_audio, tenant_queue as tq
from runner.mcp_client import AuthError, ToolError
from runner.models import Feedback
from runner.orchestrator import CoachRunner, RunnerConfig
from runner.tests.test_orchestrator import (
    RECORDING_BYTES,
    RECORDING_ID,
    RECORDING_SHA,
    FakeTextModel,
    speaking_attempt,
    text_attempt,
)
from runner.tests.test_grounded_audio import valid_feedback_text


def _text_task(task_id, user_id, *, day=12, fence=0, state="queued"):
    return {
        "id": task_id, "userId": user_id, "kind": "text", "day": day,
        "fence": fence, "state": state, "next_at": 0, "lease_until": 0,
        "analysisVersion": None, "recordingId": None,
        "snapshot": {"attempt": text_attempt(attempt_id=f"v2:{task_id}")},
    }


def _speak_task(task_id, user_id, *, day=12, fence=0, state="queued", analysis_version=None):
    return {
        "id": task_id, "userId": user_id, "kind": "speaking", "day": day,
        "fence": fence, "state": state, "next_at": 0, "lease_until": 0,
        "analysisVersion": analysis_version, "recordingId": RECORDING_ID,
        "snapshot": {
            "attempt": speaking_attempt(id=f"v2:{task_id}"),
            "recording": {"sha256": RECORDING_SHA, "bytes": len(RECORDING_BYTES)},
        },
    }


class FakeQueueClient:
    def __init__(self, tasks, *, recording=RECORDING_BYTES, complete_error=None):
        self.tasks = [dict(t) for t in tasks]
        self.calls = []
        self.recording = recording
        self.complete_error = complete_error
        self.renewals = 0
        self.completed = []
        self.failed = []

    def _find(self, task_id):
        return next(t for t in self.tasks if t["id"] == task_id)

    def call_tool(self, name, args=None, *, client_run_id=None):
        args = dict(args or {})
        self.calls.append((name, args))
        if name == "claim_next_review_task":
            now = time.time() * 1000
            for t in self.tasks:
                state = t.get("state", "queued")
                due = (
                    state in ("queued", "retry_wait") and t.get("next_at", 0) <= now
                ) or (state == "running" and t.get("lease_until", 0) <= now)
                if due:
                    t["state"] = "running"
                    t["fence"] = t.get("fence", 0) + 1
                    t["lease_until"] = now + 300_000
                    # F5: report whether other tenants have due tasks
                    claimed_user = t.get("userId")
                    other_due = any(
                        o.get("userId") != claimed_user and (
                            (o.get("state", "queued") in ("queued", "retry_wait") and o.get("next_at", 0) <= now)
                            or (o.get("state") == "running" and o.get("lease_until", 0) <= now)
                        )
                        for o in self.tasks if o is not t
                    )
                    return {"task": dict(t), "otherTenantsDue": other_due}
            return {"task": None, "otherTenantsDue": False}
        if name == "read_review_recording":
            return {
                "total": len(self.recording), "length": len(self.recording),
                "offset": args["offset"], "nextOffset": None, "sha256": RECORDING_SHA,
                "base64": base64.b64encode(self.recording).decode(),
            }
        if name == "complete_review_task":
            if self.complete_error:
                raise self.complete_error
            self.completed.append(args)
            self._find(args["taskId"])["state"] = "completed"
            return {"receiptId": "r-" + args["taskId"], "feedbackId": "f", "duplicate": False}
        if name == "fail_review_task":
            self.failed.append(args)
            t = self._find(args["taskId"])
            t["state"] = "retry_wait" if args["retryable"] else "blocked"
            t["next_at"] = (args.get("nextAt") or time.time() * 1000 + 300_000) if args["retryable"] else 0
            t["lease_until"] = 0
            return {"state": t["state"]}
        if name == "renew_review_lease":
            self.renewals += 1
            return {}
        if name == "report_scheduler_heartbeat":
            return {"ok": True}
        raise AssertionError(f"unexpected tool in multi_tenant path: {name}")

    def names(self):
        return [n for n, _ in self.calls]


def mt_config(tmp_path, **overrides):
    values = {
        "state_dir": tmp_path / "state", "client_id": "c", "client_secret": "s",
        "api_key": "sk-test", "multi_tenant": True,
        "tenant_per_user_cap_cny": 5.0, "tenant_batch_cap": 3,
    }
    values.update(overrides)
    return RunnerConfig(**values)


def mt_runner(tmp_path, client, *, model=None, **overrides):
    return CoachRunner(mt_config(tmp_path, **overrides), client=client,
                       model=model or FakeTextModel())


def _fake_grounded(monkeypatch, *, analysis=None):
    old = analysis if analysis is not None else {
        "detectorVersion": "det-v1", "inventoryVersion": "inv-v1",
        "speechSeconds": 3.0, "candidates": [],
    }
    wire = {
        "schema": "bandroom-grounded-analysis-v1",
        "analysisVersion": "grounded-prosody-v1",
        "detectorVersion": old["detectorVersion"],
        "inventoryVersion": old["inventoryVersion"],
        "speechSeconds": old["speechSeconds"],
        "candidates": old.get("candidates", []),
        "calibrated_prosody": {"pause_count": 1, "pause_seconds": 0.9},
    }

    def fake_review(raw, attempt, day, *, config, model, workdir, logger=None,
                    tenant_user_id=None, reserve_scorecard=None):
        fake_review.tenant = tenant_user_id
        return Feedback(
            feedback=valid_feedback_text(),
            evidence=f"录音 {RECORDING_ID}；已校准韵律证据：停顿 1 个。",
            attempt=str(attempt["id"]),
            pronunciation=None,
            analysis=old,
            queue_analysis=wire,
        )
    fake_review.tenant = None
    monkeypatch.setattr(grounded_audio, "review_speaking_grounded", fake_review)
    return fake_review


# ① complete_review_task end-to-end: text + grounded -----------------------
def test_text_task_completes_via_queue_not_add_coach_feedback(tmp_path):
    client = FakeQueueClient([_text_task("t1", "u1")])
    report = mt_runner(tmp_path, client).run()
    assert report.processed == 1 and report.fatal is False
    assert "add_coach_feedback" not in client.names()
    assert "read_study_session" not in client.names()
    assert len(client.completed) == 1
    args = client.completed[0]
    assert args["taskId"] == "t1" and args["fence"] == 1
    assert args["feedback"] and args["evidence"]
    assert "analysis" not in args  # text tasks must not claim acoustic evidence


def test_grounded_task_completes_with_recording_sha_and_analysis(tmp_path, monkeypatch):
    fake = _fake_grounded(monkeypatch)
    client = FakeQueueClient([_speak_task("s1", "u1")])
    report = mt_runner(tmp_path, client).run()
    assert report.processed == 1 and report.fatal is False
    assert fake.tenant == "u1"  # per-user calibration bound to the claimed tenant
    assert "add_coach_feedback" not in client.names()
    args = client.completed[0]
    assert args["taskId"] == "s1" and args["fence"] == 1
    assert args["recordingSha256"] == RECORDING_SHA
    assert args["analysis"]["schema"] == "bandroom-grounded-analysis-v1"
    assert args["analysis"]["detectorVersion"] == "det-v1"
    assert args["analysisVersion"] == "grounded-prosody-v1"
    assert "pronunciation" not in args  # grounded emits no pronunciation band


# ② capped user skipped, another tenant processed -------------------------
def test_capped_user_skipped_other_tenant_processed(tmp_path):
    client = FakeQueueClient([_text_task("a1", "capped"), _text_task("b1", "ok")])
    runner = mt_runner(tmp_path, client, tenant_per_user_cap_cny=0.05)
    # pre-fill the capped user's ledger so paused() is true (text cost 0.05)
    runner._tenant_budget = tq.UserBudget(
        runner.config.resolved_state_dir() / "tenant_budget.json", 0.05)
    runner._tenant_budget.reserve("capped", 0.05)
    report = runner.run()
    assert report.capped == 1 and report.processed == 1
    assert [c["taskId"] for c in client.completed] == ["b1"]
    fail = next(f for f in client.failed if f["taskId"] == "a1")
    assert fail["retryable"] is True and fail["code"] == "per_user_budget_paused"
    assert fail["nextAt"] > time.time() * 1000  # deferred to next UTC reset


# ③ lease renewal during a long model call --------------------------------
def test_long_call_renews_lease(tmp_path):
    client = FakeQueueClient([_text_task("t1", "u1")])
    budget = tq.UserBudget(tmp_path / "b.json", 5.0)
    seen = []

    def slow_process(task):
        time.sleep(2.2)  # scaled stand-in for a 240-900 s grounded call
        seen.append(task["id"])
        return True

    # LeaseRenewer clamps the interval to a 1 s floor; 2.2 s spans >= 2 renewals.
    outcome = tq.run_one(client, slow_process, budget, lease_interval=1.0)
    assert outcome == "processed" and seen == ["t1"]
    assert client.renewals >= 2  # renewed repeatedly across the long call


def test_lease_renew_failure_is_non_fatal_and_counted(tmp_path):
    class RenewFailClient(FakeQueueClient):
        def call_tool(self, name, args=None, *, client_run_id=None):
            if name == "renew_review_lease":
                self.renewals += 1
                raise RuntimeError("lease taken over")
            return super().call_tool(name, args, client_run_id=client_run_id)

    client = RenewFailClient([_text_task("t1", "u1")])
    budget = tq.UserBudget(tmp_path / "b.json", 5.0)
    outcome = tq.run_one(client, lambda t: time.sleep(1.2) or True, budget,
                         lease_interval=1.0)
    assert outcome == "processed"  # best-effort renewal never aborts the work
    assert client.renewals >= 1


# ④ single-owner regression: multi_tenant=false unchanged -----------------
def test_single_owner_path_does_not_touch_queue(tmp_path):
    from runner.tests.test_orchestrator import FakeClient
    session = {"day": 12, "reviewAttempts": [text_attempt()]}
    client = FakeClient(session)
    runner = CoachRunner(
        RunnerConfig(state_dir=tmp_path / "s", client_id="c", client_secret="s",
                     api_key="sk", multi_tenant=False),
        client=client, model=FakeTextModel())
    report = runner.run()
    assert report.processed == 1
    assert "claim_next_review_task" not in [n for n, _, _ in client.calls]
    assert client.feedback_calls()  # saved via add_coach_feedback


# ⑤ missing tenant / snapshot fields fail closed --------------------------
def test_missing_tenant_field_is_failed(tmp_path):
    budget = tq.UserBudget(tmp_path / "b.json", 5.0)
    client = FakeQueueClient([{"id": "t", "fence": 1, "kind": "text"}])  # no userId
    assert tq.run_one(client, lambda t: True, budget) == "failed"


def test_missing_snapshot_attempt_blocks_permanently(tmp_path):
    bad = _text_task("t1", "u1")
    bad["snapshot"] = {}  # no attempt
    client = FakeQueueClient([bad])
    report = mt_runner(tmp_path, client).run()
    assert report.blocked == 1 and report.processed == 0
    fail = client.failed[0]
    assert fail["retryable"] is False and fail["code"] == "snapshot_invalid"


# ⑥ two-user fairness batch cap -------------------------------------------
def test_fairness_batch_cap_yields_to_other_tenant(tmp_path):
    tasks = [_text_task(f"a{i}", "A") for i in range(4)] + [_text_task("b0", "B")]
    client = FakeQueueClient(tasks)
    report = mt_runner(tmp_path, client, tenant_batch_cap=2).run()
    # A,A processed; third A yielded; B processed; remaining A deferred.
    assert report.processed == 3  # a0, a1, b0
    assert report.yielded >= 1
    completed = [c["taskId"] for c in client.completed]
    assert completed[:2] == ["a0", "a1"]
    assert "b0" in completed
    yielded = [f for f in client.failed if f["code"] == "per_user_batch_cap"]
    assert yielded and all(f["retryable"] for f in yielded)
    assert all(f["taskId"].startswith("a") for f in yielded)


# ⑥b F5: single-user backlog must NOT yield (no other tenant to serve) ------
def test_single_user_backlog_no_yield(tmp_path):
    """F5 Critical fix: when only one tenant has due tasks, the batch cap must
    not yield — yielding strands the backlog (burns attempts on re-claim).
    All 8 tasks should be processed in one run."""
    tasks = [_text_task(f"s{i}", "SOLO") for i in range(8)]
    client = FakeQueueClient(tasks)
    report = mt_runner(tmp_path, client, tenant_batch_cap=3).run()
    assert report.processed == 8
    assert report.yielded == 0
    assert report.failed == 0
    completed = [c["taskId"] for c in client.completed]
    assert len(completed) == 8
    # No per_user_batch_cap failures
    assert not any(f["code"] == "per_user_batch_cap" for f in client.failed)


# ⑦ speaking release-gate gap -> permanent fail-closed (owner decision A) --
@pytest.mark.parametrize("code", [
    "analysis_version_required", "analysis_not_released", "checkpoint_missing",
])
def test_speaking_release_gate_rejection_blocks_once(tmp_path, monkeypatch, code):
    _fake_grounded(monkeypatch)
    client = FakeQueueClient(
        [_speak_task("s1", "u1")],
        complete_error=ToolError("rejected", code=code, retryable=False),
    )
    report = mt_runner(tmp_path, client).run()
    assert report.blocked == 1 and report.processed == 0 and report.failed == 0
    fail = client.failed[0]
    assert fail["retryable"] is False and fail["code"] == code
    # blocked once, never re-processed (the trailing claim just discovers empty)
    assert client.names().count("complete_review_task") == 1
    assert len(client.failed) == 1


def test_transient_complete_error_stays_retryable(tmp_path, monkeypatch):
    _fake_grounded(monkeypatch)
    client = FakeQueueClient(
        [_speak_task("s1", "u1")],
        complete_error=ToolError("storage blip", code="transfer_storage_unavailable",
                                 retryable=True),
    )
    report = mt_runner(tmp_path, client).run()
    assert report.failed == 1 and report.blocked == 0
    assert client.failed[0]["retryable"] is True


# ⑧ global cap pauses the whole run (no per-task failures) ----------------
def test_global_cap_pauses_run(tmp_path):
    client = FakeQueueClient([_text_task("t1", "u1"), _text_task("t2", "u2")])
    runner = mt_runner(tmp_path, client, tenant_per_user_cap_cny=5.0,
                       tenant_global_cap_cny=0.05)
    runner._tenant_budget = tq.UserBudget(
        runner.config.resolved_state_dir() / "tenant_budget.json", 5.0, 0.05)
    runner._tenant_budget.reserve("seed", 0.05)  # exhaust the global cap
    report = runner.run()
    assert report.paused is True and report.processed == 0
    assert report.detail == "tenant_global_cap_paused"
    assert not client.completed and not client.failed


# config parsing ----------------------------------------------------------
def test_config_defaults_multi_tenant_off(tmp_path):
    cfg = RunnerConfig()
    assert cfg.multi_tenant is False
    assert cfg.tenant_per_user_cap_cny == 2.0
    assert cfg.tenant_global_cap_cny is None
    assert cfg.tenant_batch_cap == 3


def test_load_config_parses_tenant_section(tmp_path, monkeypatch):
    from runner.orchestrator import load_config
    monkeypatch.setenv("BANDROOM_RUNNER_CLIENT_ID", "c")
    monkeypatch.setenv("BANDROOM_RUNNER_CLIENT_SECRET", "s")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk")
    p = tmp_path / "config.toml"
    p.write_text(
        '[runner]\nmulti_tenant = true\ntenant_per_user_cap_cny = 1.5\n'
        'tenant_global_cap_cny = 8.0\ntenant_client_run_id = "mt-runner"\n'
        'tenant_batch_cap = 5\n'
    )
    cfg = load_config(p)
    assert cfg.multi_tenant is True
    assert cfg.tenant_per_user_cap_cny == 1.5
    assert cfg.tenant_global_cap_cny == 8.0
    assert cfg.tenant_client_run_id == "mt-runner"
    assert cfg.tenant_batch_cap == 5


def test_auth_error_is_fatal_in_queue_run(tmp_path):
    class AuthClient(FakeQueueClient):
        def call_tool(self, name, args=None, *, client_run_id=None):
            if name == "claim_next_review_task":
                raise AuthError("token rejected")
            return super().call_tool(name, args, client_run_id=client_run_id)

    client = AuthClient([_text_task("t1", "u1")])
    report = mt_runner(tmp_path, client).run()
    assert report.fatal is True and report.detail == "auth_failed"
