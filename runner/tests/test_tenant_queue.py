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