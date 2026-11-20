"""MT-3 runner-local retention cleanup tests.

Old cache/log files are removed; recent files and account-lifetime state
(state.json, tenant_budget.json, pause_calibration.json, config files) survive.
"""

from __future__ import annotations

import os
import time

from runner.retention_cleanup import cleanup

DAY = 86_400.0
NOW = 1_800_000_000.0


def _make(path, *, age_days: float, content: bytes = b"x") -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    stamp = NOW - age_days * DAY
    os.utime(path, (stamp, stamp))
    return str(path)


def _layout(tmp_path):
    state = tmp_path / "state"
    cache = tmp_path / "state" / "acoustic-cache"
    state.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    return state, cache


def test_deletes_old_cache_and_logs_keeps_new_and_account_lifetime(tmp_path):
    state, cache = _layout(tmp_path)

    old_cache = _make(cache / "ab" / "detector-old.json", age_days=8)
    new_cache = _make(cache / "cd" / "detector-new.json", age_days=1)
    old_log = _make(state / "coach-runner.log", age_days=31)
    old_rotated = _make(state / "coach-runner.log.1", age_days=45)
    new_log = _make(state / "recent.log", age_days=2)
    logs_dir_old = _make(state / "logs" / "runner.log", age_days=40)

    state_json = _make(state / "state.json", age_days=400, content=b'{"version":1}')
    budget = _make(state / "tenant_budget.json", age_days=400, content=b"{}")
    pause = _make(state / "pause_calibration.json", age_days=400, content=b"{}")
    config = _make(state / "config.toml", age_days=400, content=b"[runner]")
    lock = _make(state / "runner.lock", age_days=400, content=b"")

    report = cleanup(state, cache, now=NOW)

    assert old_cache in report["cache_deleted"]
    assert old_log in report["log_deleted"]
    assert old_rotated in report["log_deleted"]
    assert logs_dir_old in report["log_deleted"]

    assert not os.path.exists(old_cache)
    assert not os.path.exists(old_log)
    assert not os.path.exists(old_rotated)
    assert not os.path.exists(logs_dir_old)

    assert os.path.exists(new_cache), "recent cache kept"
    assert os.path.exists(new_log), "recent log kept"
    for preserved in (state_json, budget, pause, config, lock):
        assert os.path.exists(preserved), f"account-lifetime file kept: {preserved}"

    assert report["errors"] == []
    assert report["bytes_freed"] > 0


def test_dry_run_deletes_nothing(tmp_path):
    state, cache = _layout(tmp_path)
    old_cache = _make(cache / "aa" / "detector.json", age_days=8)
    old_log = _make(state / "old.log", age_days=31)

    report = cleanup(state, cache, now=NOW, dry_run=True)

    assert old_cache in report["cache_deleted"]
    assert old_log in report["log_deleted"]
    assert os.path.exists(old_cache)
    assert os.path.exists(old_log)
    assert report["bytes_freed"] == 0


def test_idempotent(tmp_path):
    state, cache = _layout(tmp_path)
    _make(cache / "aa" / "detector.json", age_days=8)
    _make(state / "old.log", age_days=31)

    first = cleanup(state, cache, now=NOW)
    assert first["cache_deleted"] and first["log_deleted"]

    second = cleanup(state, cache, now=NOW)
    assert second["cache_deleted"] == []
    assert second["log_deleted"] == []
    assert second["errors"] == []


def test_refuses_cache_dir_that_is_the_state_dir(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    state_json = _make(state / "state.json", age_days=400)
    stray = _make(state / "unknown.json", age_days=400)

    report = cleanup(state, state, now=NOW)

    assert report["errors"], "unsafe cache root is refused"
    assert os.path.exists(state_json)
    assert os.path.exists(stray), "no files deleted when the cache root is unsafe"


def test_missing_directories_are_safe(tmp_path):
    report = cleanup(tmp_path / "missing-state", tmp_path / "missing-cache", now=NOW)
    assert report["cache_deleted"] == []
    assert report["log_deleted"] == []
    assert report["errors"] == []


def test_cli_dry_run(tmp_path, capsys):
    from runner import retention_cleanup

    state, cache = _layout(tmp_path)
    old = cache / "aa" / "detector.json"
    old.parent.mkdir(parents=True, exist_ok=True)
    old.write_bytes(b"x")
    # main() uses wall-clock time; anchor this file to the real "now".
    stamp = time.time() - 8 * DAY
    os.utime(old, (stamp, stamp))

    assert retention_cleanup.main([
        "--state-dir", str(state), "--cache-dir", str(cache), "--dry-run",
    ]) == 0
    output = capsys.readouterr().out
    assert "detector.json" in output
    assert os.path.exists(old)