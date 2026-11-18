#!/usr/bin/env python3
"""Tests for the observation-window evaluator.

Three groups:
  1. C4 probe instrument regressions — the 2026-11-17 FAILED verdict was an
     instrument artifact: (a) the default Python-urllib UA is blocked by
     Cloudflare on this site, (b) urlopen followed the 302 to the Access login
     page and reported 200, so ``== 302`` could never hold. These tests use a
     real loopback HTTP server and would FAIL against the original probe.
  2. Probe hardening regressions — the 2026-11-18T09:55Z re-evaluation hit a
     transient transport failure on both network probes (C2 observed None,
     C4 unrecorded) while the runner's authenticated path was healthy.
     Transport failures must be retried with backoff; MEASURED values must be
     final (fail-closed); every attempt must be recorded in the verdict.
  3. Window logic — frozen criteria keys, early-exit before the scheduled end,
     the existing-verdict guard, FAILED exit code, and --note-file provenance.

No external network access and no paid model call. Fixtures live in temp dirs.
"""
from __future__ import annotations

import contextlib
import http.server
import importlib.util
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

B = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("owe", B / "observation_window_eval.py")
owe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owe)

RESULTS = []


def check(name, ok):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name)


# --------------------------------------------------------------------------
# Group 1: probe instrument against a real loopback server
# --------------------------------------------------------------------------

class _Handler(http.server.BaseHTTPRequestHandler):
    seen = []  # (path, user-agent, custom-header)
    flaky_hits = 0

    def do_GET(self):
        _Handler.seen.append((self.path, self.headers.get("User-Agent"),
                              self.headers.get("X-Probe-Test")))
        if self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", "/target")
            self.end_headers()
        elif self.path == "/forbidden":
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"blocked")
        elif self.path == "/flaky":
            _Handler.flaky_hits += 1
            if _Handler.flaky_hits <= 2:
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b"transient")
            else:
                self.send_response(302)
                self.send_header("Location", "/target")
                self.end_headers()
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


@contextlib.contextmanager
def local_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_probe_instrument():
    _Handler.seen = []
    with local_server() as base:
        # Bug B regression: a correct 302 must be reported as 302, NOT followed
        # to the 200 target. The original urlopen-based probe returned 200 here.
        status = owe.http_status(base + "/redir")
        check("302 first hop reported as 302 (no redirect following)", status == 302)
        check("redirect target was never fetched",
              all(path != "/target" for path, _, _ in _Handler.seen))

        # Bug A regression: the probe must not send the default Python-urllib
        # UA, which Cloudflare blocks on the production site (403 / TLS drop).
        owe.http_status(base + "/")
        ua = _Handler.seen[-1][1]
        check("probe UA is not Python-urllib", not (ua or "").startswith("Python-urllib"))
        check("probe UA is the browser-like constant", ua == owe.PROBE_UA)
        check("PROBE_UA looks like a browser", "Mozilla/5.0" in owe.PROBE_UA)

        check("200 reported as 200", owe.http_status(base + "/") == 200)
        check("403 reported as 403 (HTTPError branch)",
              owe.http_status(base + "/forbidden", sleep=lambda s: None) == 403)
        check("caller headers are merged",
              owe.http_status(base + "/", {"X-Probe-Test": "yes"}) == 200
              and _Handler.seen[-1][2] == "yes")

    # Unreachable server -> -1 (a failed criterion, never a crash).
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead_port = s.getsockname()[1]
    check("unreachable server returns -1",
          owe.http_status(f"http://127.0.0.1:{dead_port}/", sleep=lambda s: None) == -1)


# --------------------------------------------------------------------------
# Group 2: retry hardening — transport failures retried, measurements final
# --------------------------------------------------------------------------

def test_probe_hardening():
    _Handler.seen = []
    _Handler.flaky_hits = 0
    noop = lambda s: None  # noqa: E731 - keep tests fast
    with local_server() as base:
        # Transient 503s then a correct 302: the probe must ride through.
        record = []
        status = owe.http_status(base + "/flaky", record=record, sleep=noop)
        check("transient 503s retried until 302", status == 302)
        check("flaky probe recorded every attempt",
              [r.get("status") for r in record] == [503, 503, 302])

        # A MEASURED 200 is final: exactly one attempt, no retry.
        record = []
        status = owe.http_status(base + "/", record=record, sleep=noop)
        check("measured 200 is final (one attempt)", status == 200 and len(record) == 1)

        # A persistent 403 is a measurement too: fail closed after the budget,
        # never retry forever, and record the raw evidence.
        record = []
        status = owe.http_status(base + "/forbidden", record=record, sleep=noop)
        check("persistent 403 fails closed at budget",
              status == 403 and len(record) == owe.PROBE_ATTEMPTS)
        check("403 attempts all recorded", all(r.get("status") == 403 for r in record))

    # Transport exceptions are retried and recorded as errors, ending at -1.
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead_port = s.getsockname()[1]
    record = []
    status = owe.http_status(f"http://127.0.0.1:{dead_port}/", record=record, sleep=noop)
    check("transport errors retried to budget then -1",
          status == -1 and len(record) == owe.PROBE_ATTEMPTS)
    check("transport attempts recorded as errors", all("error" in r for r in record))

    # deployed_version: transient transport failure then a valid payload.
    saved_urlopen = urllib.request.urlopen
    saved_env = {k: os.environ.get(k) for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
    os.environ["CLOUDFLARE_ACCOUNT_ID"] = "test-account"
    os.environ["CLOUDFLARE_API_TOKEN"] = "test-token"

    class _FakeResponse:
        def __init__(self, payload):
            self._payload = payload
        def read(self):
            return json.dumps(self._payload).encode()

    try:
        calls = []
        def flaky_urlopen(req, timeout=None):
            calls.append(req.full_url)
            if len(calls) == 1:
                raise urllib.error.URLError("transient blip")
            return _FakeResponse({"result": {"items": [{"id": "v1"}]}})
        urllib.request.urlopen = flaky_urlopen
        record = []
        version = owe.deployed_version(record=record, sleep=noop)
        check("version probe rides through transient error", version == "v1")
        check("version probe recorded error then measurement",
              len(record) == 2 and "error" in record[0] and record[1].get("version") == "v1")
        check("version probe hits the versions API",
              all("/workers/scripts/bandroom/versions" in u for u in calls))

        # A MEASURED different version is final: one attempt, no retry.
        urllib.request.urlopen = lambda req, timeout=None: _FakeResponse(
            {"result": {"items": [{"id": "v2-different"}]}})
        record = []
        version = owe.deployed_version(record=record, sleep=noop)
        check("measured different version is final",
              version == "v2-different" and len(record) == 1)

        # Auth errors are final, not transient.
        def auth_error(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)
        urllib.request.urlopen = auth_error
        record = []
        version = owe.deployed_version(record=record, sleep=noop)
        check("401 fails immediately without retry", version is None and len(record) == 1)

        # Missing credentials: recorded, no network call.
        del os.environ["CLOUDFLARE_API_TOKEN"]
        record = []
        version = owe.deployed_version(record=record, sleep=noop)
        check("missing credentials recorded as error",
              version is None and len(record) == 1 and "error" in record[0])
    finally:
        urllib.request.urlopen = saved_urlopen
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# --------------------------------------------------------------------------
# Group 3: window logic with patched probes and temp fixtures
# --------------------------------------------------------------------------

FROZEN_KEYS = {
    "C1_full_24h_elapsed", "C2_worker_version_unchanged",
    "C3_runner_healthy_non_fatal", "C4_unauthenticated_redirected_302",
    "C5_authenticated_mcp_read_works", "C6_no_failed_review_accumulation",
    "C7_safety_config_unchanged",
}

START = datetime(2026, 11, 16, 4, 47, 50, tzinfo=timezone.utc)
END = START + timedelta(hours=24)


@contextlib.contextmanager
def patched_window(td, *, now_at, verdict_prior=None, status=302,
                   version="v1", health_ok=True, failed_total=0,
                   read_ok=True, safety_ok=True):
    """Point the module at temp fixtures and deterministic probes."""
    window_path = pathlib.Path(td) / "window.json"
    verdict_path = pathlib.Path(td) / "verdict.json"
    window_path.write_text(json.dumps({"new_window": {
        "start": START.isoformat(), "scheduled_end": END.isoformat(),
        "worker_version": "v1"}}))
    if verdict_prior is not None:
        verdict_path.write_text(json.dumps(verdict_prior))

    saved = {k: getattr(owe, k) for k in
             ("WINDOW", "VERDICT", "now", "deployed_version", "runner_health",
              "mcp_read", "safety_config", "http_status")}

    def fake_version(*, record=None, sleep=None):
        if record is not None:
            record.append({"attempt": 1, "version": version})
        return version

    def fake_status(url, headers=None, *, record=None, sleep=None):
        if record is not None:
            record.append({"attempt": 1, "status": status})
        return status

    owe.WINDOW = window_path
    owe.VERDICT = verdict_path
    owe.now = lambda: now_at
    owe.deployed_version = fake_version
    owe.runner_health = lambda: {"ok": health_ok, "failedTotal": failed_total,
                                 "detail": "patched"}
    owe.mcp_read = lambda: {"ok": read_ok}
    owe.safety_config = lambda: {"ok": safety_ok}
    owe.http_status = fake_status
    try:
        yield window_path, verdict_path
    finally:
        for k, v in saved.items():
            setattr(owe, k, v)


def test_window_logic():
    after_end = END + timedelta(seconds=7)

    # Before the scheduled end: nothing written, exit 0.
    with tempfile.TemporaryDirectory() as td:
        with patched_window(td, now_at=END - timedelta(hours=1)):
            rc = owe.main([])
            check("before end: exit 0", rc == 0)
            check("before end: no verdict written", not (pathlib.Path(td) / "verdict.json").exists())

    # All criteria met: PASSED, exit 0, frozen keys exactly, raw probe evidence.
    with tempfile.TemporaryDirectory() as td:
        with patched_window(td, now_at=after_end) as (_, vp):
            rc = owe.main([])
            verdict = json.loads(vp.read_text())
            check("all met: exit 0", rc == 0)
            check("all met: PASSED", verdict["verdict"] == "PASSED")
            check("criteria keys frozen (C1..C7, nothing dropped)",
                  set(verdict["checks"]) == FROZEN_KEYS)
            check("all seven checks true", all(verdict["checks"].values()))
            check("elapsed >= 24h", verdict["elapsed_hours"] >= 24.0)
            check("no evaluation_note without --note-file", "evaluation_note" not in verdict)
            check("verdict records raw C4 probe evidence",
                  verdict["evidence"]["c4Probe"]["attempts"][-1]["status"] == 302
                  and verdict["evidence"]["c4Probe"]["url"] == owe.SITE + "/")
            check("verdict records raw version probe evidence",
                  verdict["evidence"]["workerVersionProbe"]["attempts"][-1]["version"] == "v1")

    # C4 failing (the incident shape): FAILED, exit 1, honest note.
    with tempfile.TemporaryDirectory() as td:
        with patched_window(td, now_at=after_end, status=403) as (_, vp):
            rc = owe.main([])
            verdict = json.loads(vp.read_text())
            check("C4 blocked: exit 1", rc == 1)
            check("C4 blocked: FAILED", verdict["verdict"] == "FAILED")
            check("C4 blocked: only C4 false",
                  verdict["checks"]["C4_unauthenticated_redirected_302"] is False
                  and all(v for k, v in verdict["checks"].items() if not k.startswith("C4")))
            check("C4 blocked: raw 403 preserved in evidence",
                  verdict["evidence"]["c4Probe"]["attempts"][-1]["status"] == 403)

    # Existing verdict for the SAME window: guard refuses re-evaluation.
    with tempfile.TemporaryDirectory() as td:
        prior = {"window_start": START.isoformat(), "verdict": "FAILED"}
        with patched_window(td, now_at=after_end, verdict_prior=prior) as (_, vp):
            rc = owe.main([])
            check("same-window guard: exit 0", rc == 0)
            check("same-window guard: verdict untouched",
                  json.loads(vp.read_text()) == prior)

    # Existing verdict for a DIFFERENT window: evaluates the new one.
    with tempfile.TemporaryDirectory() as td:
        prior = {"window_start": (START - timedelta(days=2)).isoformat(), "verdict": "FAILED"}
        with patched_window(td, now_at=after_end, verdict_prior=prior) as (_, vp):
            rc = owe.main([])
            check("different window: re-evaluates", rc == 0
                  and json.loads(vp.read_text())["window_start"] == START.isoformat())

    # --note-file embeds provenance verbatim.
    with tempfile.TemporaryDirectory() as td:
        note = {"reason": "instrument fix", "original_verdict": "FAILED",
                "evidence": ["403 with Python-urllib UA", "302 with browser UA no-follow"]}
        note_path = pathlib.Path(td) / "note.json"
        note_path.write_text(json.dumps(note))
        with patched_window(td, now_at=after_end) as (_, vp):
            rc = owe.main(["--note-file", str(note_path)])
            verdict = json.loads(vp.read_text())
            check("note-file: exit 0", rc == 0)
            check("note-file: embedded verbatim", verdict.get("evaluation_note") == note)

    # --note-file missing: fail loudly, write nothing (provenance must not drop).
    with tempfile.TemporaryDirectory() as td:
        with patched_window(td, now_at=after_end) as (_, vp):
            try:
                owe.main(["--note-file", str(pathlib.Path(td) / "absent.json")])
                rc = "no-exception"
            except FileNotFoundError:
                rc = "raised"
            check("missing note-file: raises", rc == "raised")
            check("missing note-file: no verdict written", not vp.exists())

    # C2: a changed worker version fails even when everything else holds.
    with tempfile.TemporaryDirectory() as td:
        with patched_window(td, now_at=after_end, version="v2-different") as (_, vp):
            rc = owe.main([])
            verdict = json.loads(vp.read_text())
            check("version changed: FAILED", rc == 1 and verdict["verdict"] == "FAILED"
                  and verdict["checks"]["C2_worker_version_unchanged"] is False)

    # C4 probes the site root specifically.
    with tempfile.TemporaryDirectory() as td:
        with patched_window(td, now_at=after_end):
            captured = []
            def spy(url, headers=None, *, record=None, sleep=None):
                captured.append(url)
                return 302
            owe.http_status = spy
            owe.main([])
            check("C4 probes SITE root", captured == [owe.SITE + "/"])


def main():
    test_probe_instrument()
    test_probe_hardening()
    test_window_logic()
    failed = [n for n, ok in RESULTS if not ok]
    print(f"\nRESULT: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS"
          + (f"  FAILURES: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
