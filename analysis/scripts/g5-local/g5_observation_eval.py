#!/usr/bin/env python3
"""Independent G5 24h observation evaluator (NEW versioned profile).

This is a SEPARATE instance from the production evaluator
(``analysis/scripts/observation/observation_window_eval.py``). It reads an
env-configurable window JSON and writes an env-configurable verdict JSON so it
can run alongside production window #10 without overwriting its files:

  BANDROOM_G5_WINDOW   window JSON   (default ~/.bandroom-acoustic/G5_OBSERVATION_WINDOW.json)
  BANDROOM_G5_VERDICT  verdict JSON  (default ~/.bandroom-acoustic/G5_OBSERVATION_WINDOW_VERDICT.json)
  BANDROOM_G5_WAKES    optional wake-log JSON (else window["new_window"]["wakes"])
  BANDROOM_G5_LAUNCHD_LABEL  local scheduler label (default com.bandroom.g5-scheduler)
  BANDROOM_G5_HEALTH_URL     optional liveness endpoint; adds C7 when set

G5-specific criteria (frozen here, never negotiated at evaluation time):
  C1 full scheduled window elapsed (now >= scheduled_end and >= 86400 s)
  C2 local scheduled wakes >= 3 (distinct times, no approval prompts)
  C3 wake span >= 86400 s
  C4 no manual intervention (window manualInterventions == 0)
  C5 fail-closed: window failClosed is true and no wake is fatal / errored
  C6 local scheduler alive (launchd label present)
  C7 (optional) health endpoint first-hop status == expected (default 200)

A verdict is written only at/after scheduled_end, once per window. Before that
the evaluator writes nothing and exits 0. A missing measurement is a FAILED
criterion, never an inferred pass.

Transport hardening is inherited (as a new versioned profile) from the
production evaluator: a browser-like ``PROBE_UA`` (Cloudflare blocks the
default ``Python-urllib`` UA), a no-redirect opener that asserts on the first
hop, and bounded retries for TRANSPORT failures only. Measured statuses are
final and never retried.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HOME = pathlib.Path.home()
WINDOW = pathlib.Path(os.environ.get(
    "BANDROOM_G5_WINDOW", HOME / ".bandroom-acoustic" / "G5_OBSERVATION_WINDOW.json"))
VERDICT = pathlib.Path(os.environ.get(
    "BANDROOM_G5_VERDICT", HOME / ".bandroom-acoustic" / "G5_OBSERVATION_WINDOW_VERDICT.json"))
WAKES = pathlib.Path(os.environ["BANDROOM_G5_WAKES"]) if os.environ.get("BANDROOM_G5_WAKES") else None
LAUNCHD_LABEL = os.environ.get("BANDROOM_G5_LAUNCHD_LABEL", "com.bandroom.g5-scheduler")
HEALTH_URL = os.environ.get("BANDROOM_G5_HEALTH_URL", "")
PROTOCOL_LABEL = "G5-owner-attested(single-root-four-key)"

# Hardened probe constants (new versioned profile, same fixes as production).
PROBE_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
PROBE_ATTEMPTS = 4
PROBE_BACKOFF_S = (2, 5, 11)
RETRYABLE_HTTP = {403, 429, 500, 502, 503, 504}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_PROBE_OPENER = urllib.request.build_opener(_NoRedirect)


def now() -> datetime:
    return datetime.now(timezone.utc)


def parse(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def http_status(url: str, headers: dict | None = None, *,
                record: list | None = None, sleep=time.sleep) -> int:
    """First-hop status; retries transport failures, returns measured values."""
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


def scheduler_alive() -> dict:
    try:
        listed = subprocess.run(["launchctl", "list"], capture_output=True, text=True, check=False)
    except OSError as exc:  # pragma: no cover - non-macOS
        return {"ok": False, "detail": f"launchctl unavailable: {exc}"}
    ok = LAUNCHD_LABEL in (listed.stdout or "")
    return {"ok": ok, "label": LAUNCHD_LABEL}


def load_wakes(window: dict, wake_path: pathlib.Path | None) -> list:
    if wake_path is not None:
        payload = json.loads(wake_path.read_text())
        if isinstance(payload, dict):
            return payload.get("wakes") or []
        return payload if isinstance(payload, list) else []
    return window.get("wakes") or []


def validate_wakes(raw: list, scheduler_label: str) -> dict:
    valid, invalid = [], []
    times, run_ids = [], []
    prompts = 0
    fatal = False
    for row in raw:
        if not isinstance(row, dict):
            invalid.append("non-object wake row")
            continue
        try:
            at = parse(row["at"])
        except (KeyError, TypeError, ValueError):
            invalid.append(f"wake has no valid 'at': {row!r}"[:120])
            continue
        source = row.get("source")
        ok_source = source in (scheduler_label, "local-scheduler", "local-runner")
        run_id = row.get("officialRunId")
        row_prompts = row.get("approvalPrompts")
        if not ok_source:
            invalid.append(f"wake source {source!r} is not the local scheduler")
            continue
        if not isinstance(row_prompts, int) or isinstance(row_prompts, bool) or row_prompts != 0:
            invalid.append(f"wake approvalPrompts must be 0, got {row_prompts!r}")
            continue
        if row.get("fatal") is True or row.get("errors"):
            fatal = True
        prompts += row_prompts
        times.append(at)
        if isinstance(run_id, str) and run_id:
            run_ids.append(run_id)
        valid.append(row)
    span = (max(times) - min(times)).total_seconds() if len(times) >= 2 else 0.0
    distinct_times = len({t.isoformat() for t in times}) == len(times)
    distinct_runs = len(set(run_ids)) == len(run_ids) if run_ids else True
    return {
        "valid": valid,
        "invalid": invalid,
        "count": len(valid),
        "spanSeconds": span,
        "approvalPrompts": prompts,
        "fatal": fatal,
        "distinctTimes": distinct_times,
        "distinctRunIds": distinct_runs,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--note-file", type=pathlib.Path, default=None,
                        help="JSON provenance note embedded verbatim in the verdict")
    args = parser.parse_args(argv)

    note = None
    if args.note_file is not None:
        note = json.loads(args.note_file.read_text())

    if not WINDOW.is_file():
        print(f"window file not found: {WINDOW} (fail-closed, no verdict)")
        return 2
    window = json.loads(WINDOW.read_text())
    current = window.get("new_window") or window
    start, end = current.get("start"), current.get("scheduled_end")
    if not start or not end:
        print("window file has no start/scheduled_end; nothing to evaluate")
        return 0

    if VERDICT.exists():
        prior = json.loads(VERDICT.read_text())
        if prior.get("window_start") == start:
            print("this G5 window already has a recorded verdict; not re-evaluating")
            return 0

    if now() < parse(end):
        remaining = (parse(end) - now()).total_seconds() / 3600.0
        print(f"G5 window still running; {remaining:.2f}h remaining - no verdict written")
        return 0

    wakes_raw = load_wakes(current, WAKES)
    wake = validate_wakes(wakes_raw, LAUNCHD_LABEL)
    manual = current.get("manualInterventions")
    manual_interventions = manual if isinstance(manual, int) and not isinstance(manual, bool) else 0
    fail_closed = current.get("failClosed") is True
    scheduler = scheduler_alive()

    checks = {
        "G5_C1_full_scheduled_window_elapsed": (
            now() >= parse(end)
            and (now() - parse(start)).total_seconds() >= 86_400),
        "G5_C2_local_scheduled_wakes_ge_3": (
            wake["count"] >= 3 and wake["distinctTimes"] and wake["distinctRunIds"]
            and not wake["invalid"]),
        "G5_C3_wake_span_ge_86400": wake["spanSeconds"] >= 86_400,
        "G5_C4_no_manual_intervention": (
            manual_interventions == 0 and wake["approvalPrompts"] == 0),
        "G5_C5_fail_closed_no_fatal": (
            fail_closed and not wake["fatal"]),
        "G5_C6_local_scheduler_alive": bool(scheduler.get("ok")),
    }
    evidence = {
        "wakes": {
            "count": wake["count"],
            "spanSeconds": round(wake["spanSeconds"], 3),
            "approvalPrompts": wake["approvalPrompts"],
            "invalid": wake["invalid"],
            "fatal": wake["fatal"],
        },
        "scheduler": scheduler,
        "windowFailClosed": fail_closed,
        "manualInterventions": manual_interventions,
    }
    if HEALTH_URL:
        record: list = []
        status = http_status(HEALTH_URL, record=record)
        expected = int(current.get("healthExpectedStatus", 200))
        checks["G5_C7_health_endpoint"] = status == expected
        evidence["healthProbe"] = {"url": HEALTH_URL, "expected": expected,
                                   "observed": status, "attempts": record}

    passed = all(checks.values())
    verdict = {
        "schema": "bandroom-g5-local-observation-verdict-v1",
        "protocolLabel": PROTOCOL_LABEL,
        "identityScope": "local-attestation",
        "evaluatedAt": now().isoformat(),
        "window_start": start,
        "scheduled_end": end,
        "elapsed_hours": round((now() - parse(start)).total_seconds() / 3600.0, 3),
        "checks": checks,
        "evidence": evidence,
        "verdict": "PASSED" if passed else "FAILED",
        "note": ("All frozen G5-local criteria met over the full window." if passed else
                 "At least one frozen G5-local criterion failed; a missing measurement "
                 "is never an inferred pass."),
        "singleRootDisclosure": (
            "Local G5 evidence is owner-attested (single-root-four-key), not "
            "multi-party independent."),
    }
    if note is not None:
        verdict["evaluation_note"] = note
    VERDICT.parent.mkdir(parents=True, exist_ok=True)
    VERDICT.write_text(json.dumps(verdict, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"verdict": verdict["verdict"], "checks": checks}, ensure_ascii=False, indent=2))
    print("wrote", VERDICT)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())