#!/usr/bin/env python3
"""Evaluate the production observation window against frozen criteria.

Runs periodically (launchd, every 30 min). Before the scheduled end it writes
nothing and exits 0 — it must never claim a window passed early. At or after the
end it evaluates once and records a verdict, then stops re-evaluating.

Criteria are frozen here, not negotiated at evaluation time:
  C1 full 24h elapsed
  C2 deployed Worker version unchanged since the window opened
  C3 runner alive and every recent run non-fatal with no errors
  C4 unauthenticated request still redirected to Access (302)
  C5 authenticated MCP read still works
  C6 no failed/blocked review accumulation
  C7 safety config unchanged (assertions OFF, Stage B ON)
A window interrupted by a production change is NOT claimed passed.

C4 probe instrument (fixed 2026-11-18, see README.md and
iteration-25/OBSERVATION_C4_INSTRUMENT_FIX.md in the acceptance workspace):
  - Cloudflare blocks the default ``Python-urllib`` User-Agent on this site
    (403 / dropped TLS connection), so the probe sends a browser-like UA.
    The coach runner hit the same class of block earlier and was fixed the
    same way; this evaluator originally did not inherit that fix.
  - ``urlopen`` follows redirects by default, which turned a correct 302 into
    the Access login page's 200 and made ``== 302`` unreachable. The probe
    uses a no-redirect opener and asserts on the FIRST hop.
Neither change relaxes C4: it still means "an unauthenticated request to the
site root is redirected to Cloudflare Access with status 302".

Probe hardening (second round, same day): a single-shot network probe must not
decide a 24h verdict. Transport-level failures (connection errors, and edge
blocks/5xx that prevent the probe from reaching the Worker) are retried with
backoff, up to PROBE_ATTEMPTS. A MEASURED value (302, 200, a different worker
version, ...) is final and never retried — fail-closed. Every attempt's raw
result is recorded in the verdict evidence so any failure is diagnosable
without external reproduction.

Re-evaluation protocol (instrument failure only, never verdict shopping):
  1. Prove the failure is an instrument artifact with reproducible evidence.
  2. Archive the original verdict byte-for-byte; never edit a sealed verdict.
  3. Fix the instrument and add a regression test that reproduces the failure.
  4. Move the archived verdict out of VERDICT's path and run once with
     --note-file <json> so the new verdict embeds the full provenance.
The existing-verdict guard still prevents any further re-evaluation.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

HOME = pathlib.Path.home()
# launchd cannot read ~/Documents (macOS TCC), so the canonical window file is
# mirrored here whenever it changes. The mirror is preferred; the canonical path
# is the fallback for in-session runs.
WINDOW_MIRROR = HOME / ".bandroom-acoustic" / "OBSERVATION_WINDOW.json"
# Canonical window path is deployment-specific; supply it via the environment
# rather than hard-coding any operator's local checkout. Falls back to the mirror.
WINDOW_CANONICAL = (pathlib.Path(os.environ["BANDROOM_WINDOW_CANONICAL"])
                    if os.environ.get("BANDROOM_WINDOW_CANONICAL") else WINDOW_MIRROR)
WINDOW = WINDOW_MIRROR if WINDOW_MIRROR.exists() else WINDOW_CANONICAL
VERDICT = HOME / ".bandroom-acoustic" / "OBSERVATION_WINDOW_VERDICT.json"
RUNNER = HOME / ".bandroom-runner-prod"
# The target site is deployment-specific and must be provided via the environment
# (e.g. from a private credentials file). No personal production URL is committed.
SITE = os.environ.get("BANDROOM_SITE_URL", "")
# Use the staged runner copy, not the checkout: launchd cannot read ~/Documents.
REPO = RUNNER

# Cloudflare's bot protection on this site drops/blocks the default
# Python-urllib UA. A browser-like UA is required for the unauthenticated probe.
PROBE_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# Retry budget for TRANSPORT failures only. Measured values are never retried.
PROBE_ATTEMPTS = 4
PROBE_BACKOFF_S = (2, 5, 11)
# Edge blocks / transient server errors that prevent reaching the Worker.
# 200/302/404/401 etc. are observations, not transport failures.
RETRYABLE_HTTP = {403, 429, 500, 502, 503, 504}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: C4 asserts on the first-hop status itself."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_PROBE_OPENER = urllib.request.build_opener(_NoRedirect)


def now() -> datetime:
    return datetime.now(timezone.utc)


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


def http_status(url: str, headers: dict | None = None, *,
                record: list | None = None, sleep=time.sleep) -> int:
    """First-hop status of an unauthenticated-style GET.

    Retries transport failures (exceptions, RETRYABLE_HTTP) with backoff;
    returns immediately on any measured status. Appends each attempt's raw
    result to ``record`` when provided.
    """
    merged = {"User-Agent": PROBE_UA}
    merged.update(headers or {})
    last = -1
    for attempt in range(PROBE_ATTEMPTS):
        req = urllib.request.Request(url, headers=merged)
        try:
            with _PROBE_OPENER.open(req, timeout=30) as response:
                last = response.status
                if record is not None:
                    record.append({"attempt": attempt + 1, "status": last})
                if last not in RETRYABLE_HTTP:
                    return last
        except urllib.error.HTTPError as exc:
            last = exc.code
            if record is not None:
                record.append({"attempt": attempt + 1, "status": last})
            if last not in RETRYABLE_HTTP:
                return last
        except Exception as exc:  # noqa: BLE001 - transport failure: retryable
            last = -1
            if record is not None:
                record.append({"attempt": attempt + 1,
                               "error": f"{type(exc).__name__}: {str(exc)[:120]}"})
        if attempt < PROBE_ATTEMPTS - 1:
            sleep(PROBE_BACKOFF_S[attempt])
    return last


def deployed_version(*, record: list | None = None, sleep=time.sleep) -> str | None:
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        if record is not None:
            record.append({"error": "CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set"})
        return None
    url = (f"https://api.cloudflare.com/client/v4/accounts/{account}"
           f"/workers/scripts/bandroom/versions")
    for attempt in range(PROBE_ATTEMPTS):
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}", "User-Agent": PROBE_UA})
        try:
            payload = json.loads(urllib.request.urlopen(req, timeout=30).read())
            items = (payload.get("result") or {}).get("items") or []
            version = items[0]["id"] if items else None
            if record is not None:
                record.append({"attempt": attempt + 1, "version": version})
            if version is not None:
                return version
        except urllib.error.HTTPError as exc:
            if record is not None:
                record.append({"attempt": attempt + 1, "status": exc.code})
            if exc.code not in RETRYABLE_HTTP:
                return None  # auth/permission errors are final, not transient
        except Exception as exc:  # noqa: BLE001 - transport failure: retryable
            if record is not None:
                record.append({"attempt": attempt + 1,
                               "error": f"{type(exc).__name__}: {str(exc)[:120]}"})
        if attempt < PROBE_ATTEMPTS - 1:
            sleep(PROBE_BACKOFF_S[attempt])
    return None


def runner_health() -> dict:
    logs = sorted((RUNNER / "logs").glob("*.log"), key=lambda p: p.stat().st_mtime)
    if not logs:
        return {"ok": False, "detail": "no runner log found"}
    lines = logs[-1].read_text(errors="replace").strip().splitlines()
    runs = []
    for line in lines[-40:]:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "run_id" in entry:
            runs.append(entry)
    if not runs:
        return {"ok": False, "detail": "no run records in the latest log"}
    fatal = [r for r in runs if r.get("fatal")]
    errored = [r for r in runs if r.get("errors")]
    failed = sum(int(r.get("failed") or 0) for r in runs)
    listed = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
    alive = "com.bandroom.coach-runner" in listed.stdout
    return {"ok": alive and not fatal and not errored,
            "detail": f"launchd={alive} runs={len(runs)} fatal={len(fatal)} "
                      f"errored={len(errored)} failedTotal={failed}",
            "failedTotal": failed}


def mcp_read() -> dict:
    sys.path.insert(0, str(REPO))
    try:
        from runner.orchestrator import load_config, CoachRunner
        config = load_config(RUNNER / "runner/config.prod.toml")
        client = CoachRunner(config).client
        session = client.call_tool("read_study_session", {})
        return {"ok": True, "day": session.get("day"),
                "feedback": len(session.get("feedback") or []),
                "reviewAttempts": len(session.get("reviewAttempts") or [])}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": str(exc)[:200]}


def safety_config() -> dict:
    text = (RUNNER / "runner/config.prod.toml").read_text()
    def flag(name: str) -> str | None:
        match = re.search(rf"^{name}\s*=\s*(.+)$", text, re.MULTILINE)
        return match.group(1).strip() if match else None
    assertions = flag("phoneme_assertions_enabled")
    self_listen = flag("self_listen_enabled")
    mode = flag("coach_audio_mode")
    ok = assertions == "false" and self_listen == "true" and mode == '"grounded"'
    return {"ok": ok, "phoneme_assertions_enabled": assertions,
            "self_listen_enabled": self_listen, "coach_audio_mode": mode}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--note-file", type=pathlib.Path, default=None,
                        help="JSON provenance note embedded verbatim in the verdict "
                             "(required context for a documented re-evaluation)")
    args = parser.parse_args(argv)

    note = None
    if args.note_file is not None:
        # Fail loudly rather than silently dropping provenance.
        note = json.loads(args.note_file.read_text())

    window = json.loads(WINDOW.read_text())
    current = window.get("new_window") or {}
    start, end = current.get("start"), current.get("scheduled_end")
    if not start or not end:
        print("window file has no start/scheduled_end; nothing to evaluate")
        return 0

    if VERDICT.exists():
        prior = json.loads(VERDICT.read_text())
        if prior.get("window_start") == start:
            print("this window already has a recorded verdict; not re-evaluating")
            return 0

    if now() < parse(end):
        remaining = (parse(end) - now()).total_seconds() / 3600.0
        print(f"window still running; {remaining:.2f}h remaining — no verdict written")
        return 0

    if not SITE:
        print("BANDROOM_SITE_URL is not set; refusing to evaluate (fail-closed)")
        return 2

    version_record: list = []
    c4_record: list = []
    version = deployed_version(record=version_record)
    health = runner_health()
    read = mcp_read()
    safety = safety_config()
    expected_version = current.get("worker_version")

    checks = {
        "C1_full_24h_elapsed": now() >= parse(end),
        "C2_worker_version_unchanged": bool(expected_version) and version == expected_version,
        "C3_runner_healthy_non_fatal": bool(health.get("ok")),
        "C4_unauthenticated_redirected_302": http_status(SITE + "/", record=c4_record) == 302,
        "C5_authenticated_mcp_read_works": bool(read.get("ok")),
        "C6_no_failed_review_accumulation": int(health.get("failedTotal") or 0) == 0,
        "C7_safety_config_unchanged": bool(safety.get("ok")),
    }
    passed = all(checks.values())
    verdict = {
        "schema": "bandroom-observation-window-verdict-v1",
        "evaluatedAt": now().isoformat(),
        "window_start": start,
        "scheduled_end": end,
        "elapsed_hours": round((now() - parse(start)).total_seconds() / 3600.0, 3),
        "expected_worker_version": expected_version,
        "observed_worker_version": version,
        "checks": checks,
        "evidence": {"runner": health, "mcpRead": read, "safetyConfig": safety,
                     "c4Probe": {"url": SITE + "/", "attempts": c4_record},
                     "workerVersionProbe": {"attempts": version_record}},
        "verdict": "PASSED" if passed else "FAILED",
        "note": ("All frozen criteria met over the full window." if passed else
                 "At least one frozen criterion failed; see checks. "
                 "A window interrupted by a production change is never claimed passed."),
    }
    if note is not None:
        verdict["evaluation_note"] = note
    VERDICT.write_text(json.dumps(verdict, ensure_ascii=False, indent=2))
    print(json.dumps({"verdict": verdict["verdict"], "checks": checks}, ensure_ascii=False, indent=2))
    print("wrote", VERDICT)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
