#!/usr/bin/env python3
"""MT-3 runner-local retention cleanup (design rev3.1 §4.7).

Purges only time-boxed runner-local artifacts:

* acoustic detector cache (``runner_cache``, 7 days) — the ``detector_cache_dir``
  from ``runner/config.prod.toml`` (default ``~/.bandroom-runner/acoustic-cache``);
* runner log files (``runner_logs``, 30 days) — ``*.log`` / ``*.out`` / ``*.err``
  files directly under ``state_dir`` and ``state_dir/logs``.

Account-lifetime files are never removed; DSR owns them. This script explicitly
protects ``state.json``, ``tenant_budget.json``, ``pause_calibration.json``,
``runner.lock`` and config/secret files even if they sit inside a scanned path.

Pure stdlib. Idempotent: a second run deletes nothing.

Usage::

    python3 -m runner.retention_cleanup --dry-run
    python3 -m runner.retention_cleanup --state-dir ~/.bandroom-runner-prod
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Iterable

CACHE_RETENTION_DAYS = 7
LOG_RETENTION_DAYS = 30

DEFAULT_STATE_DIR = "~/.bandroom-runner"
# Matches runner/config.prod.toml [grounded].detector_cache_dir.
DEFAULT_CACHE_DIR = "~/.bandroom-runner/acoustic-cache"

PROTECTED_NAMES = frozenset(
    {
        "state.json",
        "tenant_budget.json",
        "pause_calibration.json",
        "runner.lock",
    }
)
PROTECTED_SUFFIXES = (".toml", ".env", ".key", ".pem", ".crt", ".p12")
LOG_SUFFIXES = (".log", ".out", ".err")


def _expand(path: str | Path) -> Path:
    return Path(path).expanduser()


def _is_protected(path: Path) -> bool:
    name = path.name
    return name in PROTECTED_NAMES or name.endswith(PROTECTED_SUFFIXES)


def _is_log_file(path: Path) -> bool:
    name = path.name
    return name.endswith(LOG_SUFFIXES) or ".log." in name


def _age_days(path: Path, now: float) -> float | None:
    try:
        return (now - path.stat().st_mtime) / 86_400.0
    except OSError:
        return None


def _files_under(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return ()
    return (entry for entry in root.rglob("*") if entry.is_file())


def _files_in(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return ()
    return (entry for entry in root.iterdir() if entry.is_file())


def _unsafe_cache_root(cache_dir: Path, state_dir: Path) -> bool:
    """Refuse a cache path that is (or contains) the state dir itself."""
    try:
        cache = cache_dir.resolve()
        state = state_dir.resolve()
    except OSError:
        return True
    return cache == state or cache in state.parents


def cleanup(
    state_dir: str | Path = DEFAULT_STATE_DIR,
    cache_dir: str | Path | None = DEFAULT_CACHE_DIR,
    *,
    now: float | None = None,
    cache_days: int = CACHE_RETENTION_DAYS,
    log_days: int = LOG_RETENTION_DAYS,
    dry_run: bool = False,
) -> dict[str, object]:
    """Apply the local retention policy and return a content-free report."""
    moment = time.time() if now is None else float(now)
    state_root = _expand(state_dir)
    cache_root = _expand(cache_dir if cache_dir is not None else DEFAULT_CACHE_DIR)

    cache_deleted: list[str] = []
    log_deleted: list[str] = []
    protected: list[str] = []
    errors: list[str] = []
    bytes_freed = 0

    # --- acoustic detector cache (runner_cache, 7 days) ---------------------
    if _unsafe_cache_root(cache_root, state_root):
        errors.append(f"refusing unsafe cache dir (contains state dir): {cache_root}")
    else:
        for path in _files_under(cache_root):
            if _is_protected(path):
                protected.append(str(path))
                continue
            age = _age_days(path, moment)
            if age is None or age <= cache_days:
                continue
            if dry_run:
                cache_deleted.append(str(path))
                continue
            try:
                size = path.stat().st_size
                path.unlink()
            except OSError as error:  # race or permission: leave it for next run
                errors.append(f"{path}: {error}")
                continue
            cache_deleted.append(str(path))
            bytes_freed += size

    # --- runner logs (runner_logs, 30 days) ---------------------------------
    log_roots = [state_root, state_root / "logs"]
    seen: set[Path] = set()
    for root in log_roots:
        for path in _files_in(root):
            if path in seen:
                continue
            seen.add(path)
            if _is_protected(path):
                protected.append(str(path))
                continue
            if not _is_log_file(path):
                continue
            age = _age_days(path, moment)
            if age is None or age <= log_days:
                continue
            if dry_run:
                log_deleted.append(str(path))
                continue
            try:
                size = path.stat().st_size
                path.unlink()
            except OSError as error:
                errors.append(f"{path}: {error}")
                continue
            log_deleted.append(str(path))
            bytes_freed += size

    return {
        "dry_run": dry_run,
        "now": moment,
        "cache_dir": str(cache_root),
        "state_dir": str(state_root),
        "cache_retention_days": cache_days,
        "log_retention_days": log_days,
        "cache_deleted": cache_deleted,
        "log_deleted": log_deleted,
        "protected": sorted(set(protected)),
        "bytes_freed": bytes_freed,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Purge expired runner-local caches and logs.")
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR,
                        help=f"runner state directory (default: {DEFAULT_STATE_DIR})")
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR,
                        help=f"acoustic detector cache directory (default: {DEFAULT_CACHE_DIR})")
    parser.add_argument("--dry-run", action="store_true",
                        help="report candidates without deleting anything")
    args = parser.parse_args(argv)

    report = cleanup(args.state_dir, args.cache_dir, dry_run=args.dry_run)
    print(json.dumps(report, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())