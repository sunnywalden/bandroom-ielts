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


class PermanentTaskError(Exception):
    """The claimed task cannot succeed on retry.

    Raised by the processor for fail-closed contract gaps (e.g. a speaking
    completion whose analysis version has not passed the server release gate).
    ``run_one`` records a NON-retryable failure so the task is blocked once
    instead of burning its claim attempts on a deterministic rejection.
    """

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


class TaskYielded(Exception):
    """Voluntarily requeue a claimed task so another tenant can be served.

    Used by the per-user batch cap (fairness, rev2 §7 / F11): after N
    consecutive tasks for one user the runner yields the next claim retryably
    instead of monopolising the queue.
    """

    def __init__(self, code: str = "per_user_batch_cap"):
        super().__init__(code)
        self.code = code


def _next_utc_midnight_ms(now: float | None = None) -> int:
    """Start of the next UTC day in ms — the per-user budget reset boundary."""
    t = time.time() if now is None else now
    return (int(t // 86_400) + 1) * 86_400 * 1000


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
                self._log.warning("lease_renew_failed task=%s error=%s", self._task, str(exc)[:120])
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

    def global_paused(self) -> bool:
        """True when the optional global daily cap is exhausted.

        The run loop checks this BEFORE claiming so an exhausted global budget
        pauses the whole run instead of failing every tenant's task retryably.
        """
        with self._lock:
            self._roll()
            return self._global is not None and self._data["global"] >= self._global

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


def _fail(client: Any, task_id: str, fence: Any, code: str, logger: Any,
          *, retryable: bool = True, next_at: int | None = None) -> None:
    args: dict[str, Any] = {
        "taskId": task_id, "fence": int(fence), "code": code, "retryable": retryable,
    }
    if next_at is not None:
        args["nextAt"] = int(next_at)
    try:
        client.call_tool("fail_review_task", args)
    except Exception as exc:  # noqa: BLE001 - requeue is best-effort
        if logger:
            logger.warning("fail_review_task_error task=%s error=%s", task_id, str(exc)[:120])


def run_one(
    client: Any,
    process: Callable[[Mapping[str, Any]], bool],
    budget: UserBudget,
    *,
    client_run_id: str = "runner",
    lease_interval: float = DEFAULT_LEASE_INTERVAL,
    extend_ms: int = DEFAULT_EXTEND_MS,
    logger: Any = None,
    fatal_errors: tuple[type[BaseException], ...] = (),
) -> str:
    """Claim and process one task across tenants.

    Returns "processed" | "empty" | "capped" | "yielded" | "blocked" | "failed".
    The tenant (userId) and fence come from the claimed task row; a capped
    tenant is requeued (retryable, deferred to the next UTC budget reset) so the
    next claim can serve another tenant instead of pausing the whole run.

    Failure classification:
      - ``PermanentTaskError`` from the processor -> NON-retryable fail ("blocked"),
        for deterministic contract gaps that retrying cannot fix.
      - ``TaskYielded`` -> retryable fail ("yielded"), the fairness batch cap.
      - any other exception / ``False`` return -> retryable fail ("failed").
      - ``fatal_errors`` (e.g. AuthError) propagate to the caller untouched.
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
    # F5: server tells us whether other tenants have due tasks. The processor
    # uses this to skip yielding when this is the only active tenant.
    if isinstance(task, dict):
        task["_otherTenantsDue"] = bool((result or {}).get("otherTenantsDue", False))
    if budget.paused(user_id):
        # Defer to the next UTC budget reset so a capped tenant's task is not
        # re-claimed (and attempt-burned) every run while the cap holds.
        _fail(client, task_id, fence, "per_user_budget_paused", logger,
              retryable=True, next_at=_next_utc_midnight_ms())
        return "capped"
    try:
        ok = False
        with LeaseRenewer(client, user_id, task_id, fence,
                          interval=lease_interval, extend_ms=extend_ms, logger=logger):
            ok = process(task)
        if ok:
            return "processed"
    except fatal_errors:
        raise
    except PermanentTaskError as exc:
        if logger:
            logger.warning("tenant_task_blocked task=%s code=%s", task_id, exc.code)
        _fail(client, task_id, fence, exc.code, logger, retryable=False)
        return "blocked"
    except TaskYielded as exc:
        _fail(client, task_id, fence, exc.code, logger, retryable=True)
        return "yielded"
    except Exception as exc:  # noqa: BLE001 - classify as a retryable failure
        if logger:
            logger.warning("tenant_task_failed task=%s error=%s", task_id, str(exc)[:160])
    _fail(client, task_id, fence, "runner_error", logger, retryable=True)
    return "failed"