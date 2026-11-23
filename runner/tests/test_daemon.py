"""Phase 0 always-on runner (--daemon): idle backoff, heartbeat throttling,
bounded lifetime, auth back-off and graceful stop. Uses a fake clock so the
loop is deterministic and never really sleeps."""
from __future__ import annotations

import pytest

from runner.mcp_client import AuthError
from runner.orchestrator import (
    DAEMON_AUTH_FAILURE_SLEEP_SECONDS,
    DaemonReport,
    build_parser,
    daemon_idle_delay,
)
from runner.tests.test_orchestrator_multitenant import FakeQueueClient, _text_task, mt_runner


class FakeClock:
    def __init__(self, start: float = 1_800_000_000.0):
        self.now = start
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_idle_backoff_sequence_is_bounded_at_ten_seconds():
    assert [daemon_idle_delay(i) for i in range(6)] == [2.0, 4.0, 8.0, 10.0, 10.0, 10.0]
    assert daemon_idle_delay(-3) == 2.0


def test_parser_exposes_daemon_flags():
    args = build_parser().parse_args(["--daemon", "--max-runtime-seconds", "60", "--max-tasks", "5"])
    assert args.daemon is True
    assert args.max_runtime_seconds == 60.0
    assert args.max_tasks == 5
    assert build_parser().parse_args([]).daemon is False


def test_idle_daemon_throttles_heartbeats_and_exits_after_max_runtime(tmp_path):
    clock = FakeClock()
    client = FakeQueueClient([], clock=clock)
    runner = mt_runner(tmp_path, client, clock=clock)
    report = runner.run_daemon(max_runtime_seconds=300, sleep=clock.sleep)

    assert isinstance(report, DaemonReport)
    assert report.exit_reason == "max_runtime"
    assert report.processed == 0 and report.fatal is False
    # 300 s of idling at <=10 s per cycle: many claims...
    claims = client.names().count("claim_next_review_task")
    assert claims >= 30
    # ...but heartbeats at most about once per minute (not two per cycle).
    beats = [hb for hb, _ in client.heartbeats]
    assert 4 <= len(beats) <= 7
    assert all(hb["status"] == "finished" for hb in beats)
    gaps = [b - a for (_, a), (_, b) in zip(client.heartbeats, client.heartbeats[1:])]
    assert all(gap >= 60 for gap in gaps)
    # An always-on runner announces a ~60 s cadence, not the old 300 s.
    hb, sent_at = client.heartbeats[-1]
    assert hb["nextExpectedAt"] - int(sent_at * 1000) == 60_000
    # No single wait exceeds the 10 s idle ceiling.
    assert max(clock.sleeps) <= 10.0


def test_work_resets_backoff_and_is_reported_immediately(tmp_path):
    clock = FakeClock()
    client = FakeQueueClient([], clock=clock)
    runner = mt_runner(tmp_path, client, clock=clock)
    cycles = {"n": 0}
    original_run = runner.run

    def run_with_late_task():
        cycles["n"] += 1
        if cycles["n"] == 5:  # a learner submits while the daemon is idling
            client.tasks.append(_text_task("t-late", "u1"))
        return original_run()

    runner.run = run_with_late_task
    report = runner.run_daemon(max_runtime_seconds=90, sleep=clock.sleep)
    assert report.processed == 1
    assert [c["taskId"] for c in client.completed] == ["t-late"]
    # Work forces a heartbeat (not throttled) so the page sees progress.
    statuses = [hb["status"] for hb, _ in client.heartbeats]
    assert "started" in statuses  # progress heartbeat after the task
    assert statuses.count("finished") >= 2


def test_max_tasks_exits_cleanly(tmp_path):
    clock = FakeClock()
    client = FakeQueueClient([_text_task(f"t{i}", "u1") for i in range(3)], clock=clock)
    runner = mt_runner(tmp_path, client, clock=clock, tenant_batch_cap=10)
    report = runner.run_daemon(max_runtime_seconds=3600, max_tasks=2, sleep=clock.sleep)
    assert report.exit_reason == "max_tasks"
    assert report.processed >= 2


def test_stop_signal_finishes_current_pass_then_exits(tmp_path):
    clock = FakeClock()
    client = FakeQueueClient([], clock=clock)
    runner = mt_runner(tmp_path, client, clock=clock)
    calls = {"n": 0}

    def should_stop():
        calls["n"] += 1
        return calls["n"] > 3

    report = runner.run_daemon(max_runtime_seconds=3600, sleep=clock.sleep, should_stop=should_stop)
    assert report.exit_reason == "signal"
    assert report.cycles >= 1
    assert clock.now - 1_800_000_000.0 < 60  # stopped promptly, no long sleep


def test_auth_failure_backs_off_before_exiting(tmp_path):
    clock = FakeClock()

    class AuthFailClient(FakeQueueClient):
        def call_tool(self, name, args=None, *, client_run_id=None):
            if name == "claim_next_review_task":
                raise AuthError("bad credentials")
            return super().call_tool(name, args, client_run_id=client_run_id)

    client = AuthFailClient([], clock=clock)
    runner = mt_runner(tmp_path, client, clock=clock)
    report = runner.run_daemon(max_runtime_seconds=3600, sleep=clock.sleep)
    assert report.fatal is True
    assert report.exit_reason == "auth_failed"
    assert report.cycles == 1
    assert sum(clock.sleeps) == pytest.approx(DAEMON_AUTH_FAILURE_SLEEP_SECONDS)
    # A failed run's heartbeat is never throttled.
    assert [hb["status"] for hb, _ in client.heartbeats] == ["failed"]


def test_once_mode_heartbeats_are_unchanged(tmp_path):
    clock = FakeClock()
    client = FakeQueueClient([], clock=clock)
    runner = mt_runner(tmp_path, client, clock=clock)
    runner.run()
    statuses = [hb["status"] for hb, _ in client.heartbeats]
    assert statuses == ["started", "finished"]
    hb, sent_at = client.heartbeats[-1]
    assert hb["nextExpectedAt"] - int(sent_at * 1000) == runner.config.interval_seconds * 1000
