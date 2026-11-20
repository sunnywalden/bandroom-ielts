"""Tenant queue primitives: lease renewal, per-user budget, claim/process step."""
import json
import time

from runner import tenant_queue as tq


class FakeClient:
    def __init__(self, claim=None, *, renew_fail=False):
        self.calls = []
        self._claim = claim
        self.renew_fail = renew_fail

    def call_tool(self, name, args):
        self.calls.append((name, dict(args)))
        if name == "claim_next_review_task":
            return self._claim
        if name == "renew_review_lease" and self.renew_fail:
            raise RuntimeError("lease gone")
        return {}


def test_lease_renew_once_counts_and_errors():
    client = FakeClient()
    r = tq.LeaseRenewer(client, "u1", "t1", 3)
    assert r.renew_once() is True and r.renew_once() is True
    assert r.renewals == 2 and r.errors == 0
    assert client.calls[-1] == ("renew_review_lease", {"taskId": "t1", "fence": 3, "extendMs": tq.DEFAULT_EXTEND_MS})
    bad = tq.LeaseRenewer(FakeClient(renew_fail=True), "u1", "t1", 3)
    assert bad.renew_once() is False and bad.errors == 1 and bad.renewals == 0


def test_lease_renewer_carries_lease_and_retries_once():
    client = FakeClient()
    r = tq.LeaseRenewer(client, "u1", "t1", 3, lease="lease-1", retry_delay=0)
    assert r.renew_once() is True
    assert client.calls[-1] == (
        "renew_review_lease",
        {"taskId": "t1", "fence": 3, "extendMs": tq.DEFAULT_EXTEND_MS, "lease": "lease-1"},
    )

    # F6: a lease-bound renewal retries once before giving up.
    bad = FakeClient(renew_fail=True)
    r2 = tq.LeaseRenewer(bad, "u1", "t1", 3, lease="lease-1", retry_delay=0)
    assert r2.renew_once() is False
    assert r2.errors == 1 and r2.renewals == 0
    assert len([c for c in bad.calls if c[0] == "renew_review_lease"]) == 2


def test_run_one_carries_lease_to_process_and_fail(tmp_path):
    budget = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=5.0)
    seen = {}

    def proc(task):
        seen["lease"] = task.get("_lease")
        return True

    client = FakeClient({"task": {"id": "t1", "userId": "u1", "fence": 1}, "lease": "lease-ok"})
    assert tq.run_one(client, proc, budget) == "processed"
    assert seen["lease"] == "lease-ok"

    failing = FakeClient({"task": {"id": "t2", "userId": "u1", "fence": 1}, "lease": "lease-fail"})

    def boom(task):
        raise RuntimeError("model blew up")

    assert tq.run_one(failing, boom, budget) == "failed"
    fail = next(c for c in failing.calls if c[0] == "fail_review_task")[1]
    assert fail["lease"] == "lease-fail"


def test_user_budget_per_user_and_global_caps(tmp_path):
    path = tmp_path / "budget.json"
    b = tq.UserBudget(path, per_user_cap_cny=1.0)
    assert b.reserve("a", 0.5) is True
    assert abs(b.spent("a") - 0.5) < 1e-9
    assert b.reserve("a", 0.4) is True
    assert b.paused("a") is False
    assert b.reserve("a", 0.2) is False          # would exceed per-user cap
    assert b.reserve("a", 0.1) is True
    assert b.paused("a") is True                  # now at cap
    assert b.reserve("b", 0.5) is True            # other tenant unaffected
    g = tq.UserBudget(tmp_path / "g.json", per_user_cap_cny=10.0, global_cap_cny=1.0)
    assert g.reserve("x", 0.6) is True
    assert g.reserve("y", 0.6) is False           # global cap


def test_user_budget_day_rollover(tmp_path):
    clock = {"t": time.mktime(time.strptime("2026-11-20", "%Y-%m-%d"))}
    b = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=1.0, now=lambda: clock["t"])
    assert b.reserve("a", 0.9) is True
    assert b.paused("a") is False
    clock["t"] += 24 * 3600
    assert b.spent("a") == 0.0                     # new UTC day resets the ledger


def test_run_one_states(tmp_path):
    budget = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=5.0)

    # empty
    assert tq.run_one(FakeClient({"task": None}), lambda t: True, budget) == "empty"

    # processed
    task = {"id": "t1", "userId": "u1", "fence": 1}
    seen = []
    client = FakeClient({"task": task})
    assert tq.run_one(client, lambda t: seen.append(t) or True, budget) == "processed"
    assert seen == [task]
    assert not any(name == "fail_review_task" for name, _ in client.calls)

    # capped -> requeued retryable, not processed
    capped_budget = tq.UserBudget(tmp_path / "c.json", per_user_cap_cny=0.0)
    cclient = FakeClient({"task": task})
    called = {"n": 0}
    def proc(t):
        called["n"] += 1
        return True
    assert tq.run_one(cclient, proc, capped_budget) == "capped"
    assert called["n"] == 0
    fail = [c for c in cclient.calls if c[0] == "fail_review_task"][0][1]
    assert fail["retryable"] is True and fail["code"] == "per_user_budget_paused"

    # process returns False -> failed + retryable fail
    fclient = FakeClient({"task": task})
    assert tq.run_one(fclient, lambda t: False, budget) == "failed"
    assert any(c[0] == "fail_review_task" and c[1]["retryable"] for c in fclient.calls)

    # process raises -> failed
    eclient = FakeClient({"task": task})
    def boom(t):
        raise RuntimeError("model blew up")
    assert tq.run_one(eclient, boom, budget) == "failed"


def test_run_one_missing_tenant_fields_is_failed(tmp_path):
    budget = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=5.0)
    client = FakeClient({"task": {"id": "t", "fence": 1}})  # no userId
    assert tq.run_one(client, lambda t: True, budget) == "failed"

def test_user_budget_refund_floors_at_zero(tmp_path):
    b = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=1.0, global_cap_cny=1.0)
    assert b.reserve("a", 0.5) is True
    assert b.refund("a", 300_000) == 300_000
    assert abs(b.spent("a") - 0.2) < 1e-9
    # Over-refund floors at zero, including the global counter.
    assert b.refund("a", 999_999) == 200_000
    assert b.spent("a") == 0.0
    assert b.global_paused() is False
    # Refunding an unseen user is a no-op.
    assert b.refund("nobody", 100) == 0


def test_user_budget_refund_task_tracks_tagged_reservations(tmp_path):
    b = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=1.0)
    assert b.reserve("a", 0.10, task_id="t1") is True
    assert b.reserve_micro("a", 20_000, task_id="t1") is True
    assert b.reserve("a", 0.05, task_id="t2") is True
    assert b.refund_task("t1") == 120_000
    assert abs(b.spent("a") - 0.05) < 1e-9
    # Unknown/already-refunded task is a no-op.
    assert b.refund_task("t1") == 0
    # Success releases the tag without refunding.
    b.release("t2")
    assert abs(b.spent("a") - 0.05) < 1e-9
    assert b.refund_task("t2") == 0


def test_user_budget_refund_enables_retry_after_failure(tmp_path):
    b = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=0.10)
    assert b.reserve("a", 0.10, task_id="t1") is True
    assert b.paused("a") is True
    assert b.refund_task("t1") == 100_000
    assert b.paused("a") is False
    assert b.reserve("a", 0.10, task_id="t1") is True


def test_run_one_refunds_retryable_failure(tmp_path):
    budget = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=1.0)
    client = FakeClient({"task": {"id": "t1", "userId": "u1", "fence": 1}})

    def boom(task):
        assert budget.reserve("u1", 0.10, task_id=task["id"]) is True
        assert budget.reserve("u1", 0.05, task_id=task["id"]) is True
        raise RuntimeError("model blew up")

    assert tq.run_one(client, boom, budget) == "failed"
    assert budget.spent("u1") == 0.0  # retryable failure refunded the attempt
    # The task was still requeued retryably.
    fail = next(c for c in client.calls if c[0] == "fail_review_task")[1]
    assert fail["retryable"] is True


def test_run_one_keeps_reservation_on_success_and_permanent_block(tmp_path):
    budget = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=1.0)
    client = FakeClient({"task": {"id": "t1", "userId": "u1", "fence": 1}})

    def ok(task):
        assert budget.reserve("u1", 0.10, task_id=task["id"]) is True
        return True

    assert tq.run_one(client, ok, budget) == "processed"
    assert abs(budget.spent("u1") - 0.10) < 1e-9

    blocked_budget = tq.UserBudget(tmp_path / "c.json", per_user_cap_cny=1.0)
    blocked_client = FakeClient({"task": {"id": "t2", "userId": "u2", "fence": 1}})

    def blocked(task):
        assert blocked_budget.reserve("u2", 0.10, task_id=task["id"]) is True
        raise tq.PermanentTaskError("snapshot_invalid", "deterministic rejection")

    assert tq.run_one(blocked_client, blocked, blocked_budget) == "blocked"
    # A permanent rejection consumed the model call and is not refunded.
    assert abs(blocked_budget.spent("u2") - 0.10) < 1e-9


def test_partial_refund_shrinks_pending_so_failure_refund_is_exact(tmp_path):
    b = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=1.0)
    assert b.reserve("a", 0.10, task_id="t1") is True
    assert b.reserve_micro("a", 40_000, task_id="t1") is True
    # One TTS call did not succeed; refund it without double-refunding later.
    assert b.refund_reserved("a", 20_000, task_id="t1") == 20_000
    assert abs(b.spent("a") - 0.12) < 1e-9
    assert b.refund_task("t1") == 120_000
    assert b.spent("a") == 0.0


def test_run_one_carries_claim_entitlements_to_process(tmp_path):
    """MT-5 (G4, security review): the Worker's per-tenant entitlements from the
    claim response must reach the processor (source of truth), not be dropped."""
    budget = tq.UserBudget(tmp_path / "b.json", per_user_cap_cny=5.0)
    seen = {}

    def proc(task):
        seen["entitlements"] = task.get("entitlements")
        return True

    ent = {"detector_self_listen": True, "contrast_tts": False}
    client = FakeClient({"task": {"id": "t1", "userId": "u1", "fence": 1}, "entitlements": ent})
    assert tq.run_one(client, proc, budget) == "processed"
    assert seen["entitlements"] == ent

    # Absent entitlements map → None (processor fails closed for non-owner).
    seen.clear()
    client2 = FakeClient({"task": {"id": "t2", "userId": "u2", "fence": 1}})
    assert tq.run_one(client2, proc, budget) == "processed"
    assert seen["entitlements"] is None
