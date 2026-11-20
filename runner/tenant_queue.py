"""Multi-tenant runner queue primitives (rev2 §7).

Foundation for the queue-path runner:
  - LeaseRenewer: renew one task's lease in a background thread while a slow
    model call (240-900 s) runs — the server lease is only 5 min.
  - UserBudget: a host-local per-user cost ledger (micro-CNY) with an optional
    global cap, so one tenant exhausting its budget skips only that tenant.
  - run_one: claim the next due task ACROSS tenants, respect the per-user budget,
    process it under a renewing lease, and fail (retryable) on error.

The processor (``process(task) -> bool``) owns the model call and calls
complete_review_task itself. This module never selects a tenant from client
input: the tenant comes from the claimed task row (server-derived).
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

MICRO = 1_000_000
DEFAULT_LEASE_INTERVAL = 60.0
DEFAULT_EXTEND_MS = 300_000


class LeaseRenewer:
    """Renew one task lease while a slow call runs. ``renew_once`` is exposed for
    deterministic tests; the background thread is best-effort and never raises."""

    def __init__(self, client: Any, user_id: str, task_id: str, fence: int, *,
                 interval: float = DEFAULT_LEASE_INTERVAL, extend_ms: int = DEFAULT_EXTEND_MS,
                 logger: Any = None):
        self._client = client
        self._user = user_id
        self._task = task_id
        self._fence = int(fence)
        self._interval = max(1.0, float(interval))
        self._extend = int(extend_ms)
        self._log = logger
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.renewals = 0
        self.errors = 0

    def renew_once(self) -> bool:
        try:
            self._client.call_tool(
                "renew_review_lease",
                {"taskId": self._task, "fence": self._fence, "extendMs": self._extend},
            )
            self.renewals += 1
            return True
        except Exception as exc:  # noqa: BLE001 - best-effort renewal
            self.errors += 1
            if self._log:
                self._log.warning("lease_renew_failed", task=self._task, error=str(exc)[:120])
            return False

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.renew_once()

    def __enter__(self) -> "LeaseRenewer":
        self._thread = threading.Thread(target=self._run, name=f"lease-{self._user}-{self._task}", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        return False


class UserBudget:
    """Per-user cost ledger (micro-CNY) with an optional global cap."""

    def __init__(self, path: str | Path, per_user_cap_cny: float,
                 global_cap_cny: float | None = None, *, now: Callable[[], float] = time.time):
        self._path = Path(path)
        self._per = int(round(float(per_user_cap_cny) * MICRO))
        self._global = int(round(float(global_cap_cny) * MICRO)) if global_cap_cny else None
        self._now = now
        self._lock = threading.Lock()
        self._data = self._load()

    def _day(self) -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(self._now()))

    def _load(self) -> dict:
        try:
            data = json.loads(self._path.read_text())
        except Exception:  # noqa: BLE001 - missing/corrupt ledger starts empty
            data = {}
        if data.get("utcDay") != self._day():
            data = {"utcDay": self._day(), "users": {}, "global": 0}
        data.setdefault("users", {})
        data.setdefault("global", 0)
        return data

    def _roll(self) -> None:
        if self._data.get("utcDay") != self._day():
            self._data = {"utcDay": self._day(), "users": {}, "global": 0}

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(self._data))
        except Exception:  # noqa: BLE001 - persistence is best-effort
            pass

    def spent(self, user_id: str) -> float:
        with self._lock:
            self._roll()
            return self._data["users"].get(user_id, 0) / MICRO

    def paused(self, user_id: str) -> bool:
        with self._lock:
            self._roll()
            return self._data["users"].get(user_id, 0) >= self._per

    def reserve(self, user_id: str, cost_cny: float) -> bool:
        micro = int(round(float(cost_cny) * MICRO))
        with self._lock:
            self._roll()
            current = self._data["users"].get(user_id, 0)
            if current + micro > self._per:
                return False
            if self._global is not None and self._data["global"] + micro > self._global:
                return False
            self._data["users"][user_id] = current + micro
            self._data["global"] += micro
            self._save()
            return True


def _fail(client: Any, task_id: str, fence: Any, code: str, logger: Any) -> None:
    try:
        client.call_tool("fail_review_task", {
            "taskId": task_id, "fence": int(fence), "code": code, "retryable": True,
        })
    except Exception as exc:  # noqa: BLE001 - requeue is best-effort
        if logger:
            logger.warning("fail_review_task_error", task=task_id, error=str(exc)[:120])


def run_one(
    client: Any,
    process: Callable[[Mapping[str, Any]], bool],
    budget: UserBudget,
    *,
    client_run_id: str = "runner",
    lease_interval: float = DEFAULT_LEASE_INTERVAL,
    extend_ms: int = DEFAULT_EXTEND_MS,
    logger: Any = None,
) -> str:
    """Claim and process one task across tenants.

    Returns "processed" | "empty" | "capped" | "failed". The tenant (userId) and
    fence come from the claimed task row; a capped tenant is requeued (retryable)
    so the next claim can serve another tenant instead of pausing the whole run.
    """
    result = client.call_tool("claim_next_review_task", {"clientRunId": client_run_id})
    task = (result or {}).get("task") if isinstance(result, Mapping) else None
    if not task:
        return "empty"
    user_id = task.get("userId")
    task_id = task.get("id")
    fence = task.get("fence")
    if not user_id or not task_id or not fence:
        return "failed"
    if budget.paused(user_id):
        _fail(client, task_id, fence, "per_user_budget_paused", logger)
        return "capped"
    try:
        ok = False
        with LeaseRenewer(client, user_id, task_id, fence,
                          interval=lease_interval, extend_ms=extend_ms, logger=logger):
            ok = process(task)
        if ok:
            return "processed"
    except Exception as exc:  # noqa: BLE001 - classify as a retryable failure
        if logger:
            logger.warning("tenant_task_failed", task=task_id, error=str(exc)[:160])
    _fail(client, task_id, fence, "runner_error", logger)
    return "failed"