#!/usr/bin/env python3
"""Tests for the G3-local / G5-owner-attested toolchain.

Groups:
  1. key generation (four distinct Ed25519 keys, 0600/0700 perms, signers file,
     public manifest, signers-outside-bundle guard);
  2. exporter build + check_local (pass / fail / explicit waiver paths, and the
     informational M4-local profile never claiming the frozen schema);
  3. verifier (valid signatures, signers-inside-bundle rejection, exact role
     set, distinct keys, tamper detection, wrong signing namespace);
  4. independent G5 evaluator (hardened transport, early exit, wake criteria,
     fail-closed, existing-verdict guard, coexistence with production paths).

No external network and no paid model call. Fixtures live in temp dirs.
"""
from __future__ import annotations

import contextlib
import http.server
import importlib.util
import json
import pathlib
import socket
import sys
import tempfile
import threading

B = pathlib.Path(__file__).resolve().parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, B / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


export = load("g5_export", "export_g5_evidence_local.py")
verify = load("g5_verify", "verify_local_release.py")
keygen = load("g5_keys", "gen_local_keys.py")
sealer = load("g5_seal", "seal_local_bundle.py")
g5 = load("g5_eval", "g5_observation_eval.py")

RESULTS = []


def check(name, ok, detail=None):
    RESULTS.append((name, bool(ok)))
    suffix = f"  [{detail}]" if detail not in (None, "", []) else ""
    print(("PASS " if ok else "FAIL ") + name + suffix)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def good_run():
    digest = "b" * 64
    return {
        "schemaVersion": 1,
        "analysisVersion": "local-test",
        "environmentId": "test-host",
        "recording": {"recordingSha256": "a" * 64, "inputBytes": 123456},
        "execution": {"mode": "local-runner", "scheduledWakeCount": 3,
                      "spanSeconds": 90000, "approvalPrompts": 0, "failClosed": True},
        "fence": {"sequence": [1, 2, 3]},
        "coldResumed": {"coldOutputSha256": digest, "resumedOutputSha256": digest,
                        "coldEqualsResumed": True},
        "dLocal": {"coldOutputSha256": digest, "sameShaAsResumed": True, "independentProcess": True},
        "writeback": {"idempotent": True, "lostReplayRedelivered": True, "oldFenceRejected": True},
    }


def build_bundle(td, run=None):
    run_dir = pathlib.Path(td) / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(run_dir / "local-run.json", run or good_run())
    out = pathlib.Path(td) / "bundle"
    export.build_local(run_dir, out)
    return out


def make_keys(td):
    root = pathlib.Path(td) / "keys"
    public = pathlib.Path(td) / "public"
    signers = pathlib.Path(td) / "allowed-signers"
    manifest = keygen.generate(root, public, signers)
    return root, public, signers, manifest


# --------------------------------------------------------------------------
# Group 1: key generation
# --------------------------------------------------------------------------

def test_keygen():
    with tempfile.TemporaryDirectory() as td:
        root, public, signers, manifest = make_keys(td)
        roles = {row["role"] for row in manifest["roles"]}
        check("keygen: four frozen roles", roles == set(keygen.ROLES))
        blobs = {row["publicKey"].split()[1] for row in manifest["roles"]}
        check("keygen: four distinct public keys", len(blobs) == 4)
        modes = [oct((root / role / "id_ed25519").stat().st_mode & 0o777) for role in keygen.ROLES]
        check("keygen: private keys are 0600", all(mode == "0o600" for mode in modes), modes)
        dir_modes = [oct((root / role).stat().st_mode & 0o777) for role in keygen.ROLES]
        check("keygen: private key dirs are 0700", all(mode == "0o700" for mode in dir_modes), dir_modes)
        lines = signers.read_text().splitlines()
        check("keygen: allowed-signers has four lines", len(lines) == 4)
        check("keygen: allowed-signers uses ssh-ed25519",
              all(line.startswith(tuple(role + " ssh-ed25519 " for role in keygen.ROLES)) for line in lines))
        check("keygen: public manifest has fingerprints",
              all(row["fingerprint"].startswith(("256 ", "ED25519 ")) or "SHA256:" in row["fingerprint"]
                  for row in manifest["roles"]))
        # The private file contents must never appear on stdout/stderr.
        printed = []
        with contextlib.redirect_stdout(__import__("io").StringIO()) as out:
            keygen.main(["--root", str(root), "--public", str(public), "--signers", str(signers),
                         "--force"])
            printed.append(out.getvalue())
        private = (root / "release-owner" / "id_ed25519").read_text()
        check("keygen: never prints private key material", private.strip() not in printed[0])
        # Refuses to overwrite without --force.
        try:
            keygen.generate(root, public, signers)
            overwrite = "allowed"
        except keygen.Blocked:
            overwrite = "blocked"
        check("keygen: refuses silent overwrite", overwrite == "blocked")
        # Signers/public must stay outside a bundle dir.
        bundle = pathlib.Path(td) / "bundle"
        bundle.mkdir()
        try:
            keygen.generate(root, bundle / "public", bundle / "signers", force=True, bundle=bundle)
            guard = "allowed"
        except keygen.Blocked:
            guard = "blocked"
        check("keygen: refuses public keys/signers inside the bundle", guard == "blocked")


# --------------------------------------------------------------------------
# Group 2: exporter
# --------------------------------------------------------------------------

def test_exporter():
    with tempfile.TemporaryDirectory() as td:
        out = build_bundle(td)
        manifest = json.loads((out / "manifest.json").read_text())
        check("exporter: new namespace", manifest["protocol"] == export.NAMESPACE)
        check("exporter: protocol label", manifest["protocolLabel"] == export.PROTOCOL_LABEL)
        check("exporter: identity scope", manifest["identityScope"] == "local-attestation")
        check("exporter: four frozen roles", manifest["roles"] == list(export.ROLES))
        check("exporter: single-root disclosure present", "single-root" in manifest["singleRootDisclosure"])
        check("exporter: signers-outside rule recorded", "outside" in manifest["signersDistribution"].lower())
        profile = json.loads((out / "runtime-profile.json").read_text())
        check("exporter: M4-local informational", profile["status"] == "informational"
              and profile["gateRole"] == "none")
        check("exporter: frozen runtimeProfile not claimed",
              profile["frozenRuntimeProfile"]["claimed"] is False)
        check("exporter: no fabricated coldTrials", "coldTrials" not in profile)
        clause_map = json.loads((out / "clause-map.json").read_text())
        check("exporter: all replaced clauses disclosed",
              len(clause_map["replaced"]) == len(export.REPLACED_CLAUSES)
              and all(row["zdDecision"] for row in clause_map["replaced"]))
        statuses = {row["id"]: row["status"] for row in clause_map["retained"]}
        check("exporter: retained clauses pass", all(s == "pass" for s in statuses.values()), statuses)
        check("exporter: D-local disclosure attached",
              "determinism" in clause_map["independentColdDisclosure"])
        rc = export.check_local(out, require_signatures=False)
        check("exporter: check_local passes structurally", rc == 0)
        rc = export.check_local(out, require_signatures=True)
        check("exporter: check_local fails without signatures", rc == 1)

    # A real retained-clause failure must fail the bundle.
    with tempfile.TemporaryDirectory() as td:
        run = good_run()
        run["coldResumed"]["coldOutputSha256"] = "c" * 64
        run["coldResumed"]["coldEqualsResumed"] = False
        out = build_bundle(td, run)
        if not (out / "cold-output.bin").exists():
            pass
        clause_map = json.loads((out / "clause-map.json").read_text())
        status = {row["id"]: row["status"] for row in clause_map["retained"]}
        check("exporter: cold != resumed is a FAIL", status["G3-C-cold-equals-resumed"] == "fail")
        rc = export.check_local(out, require_signatures=False)
        check("exporter: check_local fails on cold != resumed", rc == 1)

    # Missing evidence is a labelled waiver, not a pass.
    with tempfile.TemporaryDirectory() as td:
        run = good_run()
        del run["coldResumed"]
        del run["writeback"]
        out = build_bundle(td, run)
        clause_map = json.loads((out / "clause-map.json").read_text())
        status = {row["id"]: row["status"] for row in clause_map["retained"]}
        check("exporter: missing cold/resumed is WAIVED",
              status["G3-C-cold-equals-resumed"] == "waived")
        check("exporter: missing writeback is WAIVED",
              status["G3-writeback-idempotent"] == "waived")
        rc = export.check_local(out, require_signatures=False)
        check("exporter: waivers keep the structural check green", rc == 0)


# --------------------------------------------------------------------------
# Group 3: verifier
# --------------------------------------------------------------------------

def test_verifier():
    with tempfile.TemporaryDirectory() as td:
        out = build_bundle(td)
        root, public, signers, _ = make_keys(td)
        public_out = pathlib.Path(td) / "public-seal"
        sealer.seal(out, root, public_out, copy_signers=signers)
        result = verify.verify_local_bundle(out, signers)
        check("verifier: valid four-role signatures accepted",
              result["signedByNamespace"] == verify.NAMESPACE)
        check("verifier: role fingerprints recorded", len(result["roleFingerprints"]) == 4)
        check("verifier: retained clauses all pass",
              all(s == "pass" for s in result["retainedClauses"].values()),
              result["retainedClauses"])
        check("verifier: single-root disclosure emitted",
              "single-root" in result["singleRootDisclosure"])

        # Tamper with an evidence file -> digest mismatch.
        tampered = pathlib.Path(td) / "tampered"
        __import__("shutil").copytree(out, tampered)
        with (tampered / "local-evidence.json").open("a") as handle:
            handle.write(" ")
        try:
            verify.verify_local_bundle(tampered, signers)
            tamper = "accepted"
        except verify.Blocked:
            tamper = "blocked"
        check("verifier: evidence tamper rejected", tamper == "blocked")

        # Signers file inside the bundle -> rejected.
        inside = out / "allowed-signers"
        inside.write_text(signers.read_text())
        try:
            verify.verify_local_bundle(out, inside)
            guard = "accepted"
        except verify.Blocked as error:
            guard = "outside" if "outside" in str(error) else "blocked"
        check("verifier: signers inside bundle rejected", guard == "outside")
        inside.unlink()

        # Missing role -> rejected.
        lines = signers.read_text().splitlines()
        short = pathlib.Path(td) / "short-signers"
        short.write_text("\n".join(lines[:-1]) + "\n")
        try:
            verify.verify_local_bundle(out, short)
            roles = "accepted"
        except verify.Blocked:
            roles = "blocked"
        check("verifier: missing role rejected", roles == "blocked")

        # Duplicate key across roles -> rejected.
        parts = [line.split() for line in lines]
        dup = [f"{parts[0][0]} {parts[0][1]} {parts[0][2]}"]
        dup += [f"{row[0]} {row[1]} {row[2]}" for row in parts[1:]]
        dup[1] = f"{parts[1][0]} ssh-ed25519 {parts[0][2]}"
        dup_path = pathlib.Path(td) / "dup-signers"
        dup_path.write_text("\n".join(dup) + "\n")
        try:
            verify.verify_local_bundle(out, dup_path)
            distinct = "accepted"
        except verify.Blocked as error:
            distinct = "distinct" if "distinct" in str(error) else "blocked"
        check("verifier: duplicate keys rejected", distinct == "distinct")

        # Corrupt signature -> rejected.
        corrupt = pathlib.Path(td) / "corrupt"
        __import__("shutil").copytree(out, corrupt)
        (corrupt / "work-auditor.sig").write_text("-----BEGIN SSH SIGNATURE-----\nnot-a-real-sig\n")
        try:
            verify.verify_local_bundle(corrupt, signers)
            sig = "accepted"
        except verify.Blocked:
            sig = "blocked"
        check("verifier: corrupt signature rejected", sig == "blocked")

    # Wrong signing namespace -> rejected.
    with tempfile.TemporaryDirectory() as td:
        out = build_bundle(td)
        root, public, signers, _ = make_keys(td)
        sealer.seal(out, root, pathlib.Path(td) / "pub", namespace="wrong.namespace")
        try:
            verify.verify_local_bundle(out, signers)
            ns = "accepted"
        except verify.Blocked:
            ns = "blocked"
        check("verifier: wrong signing namespace rejected", ns == "blocked")


# --------------------------------------------------------------------------
# Group 4: G5 evaluator
# --------------------------------------------------------------------------

class _Handler(http.server.BaseHTTPRequestHandler):
    seen = []
    flaky_hits = 0

    def do_GET(self):
        _Handler.seen.append((self.path, self.headers.get("User-Agent")))
        if self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", "/target")
            self.end_headers()
        elif self.path == "/forbidden":
            self.send_response(403)
            self.end_headers()
        elif self.path == "/flaky":
            _Handler.flaky_hits += 1
            if _Handler.flaky_hits <= 2:
                self.send_response(503)
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
        else:
            self.send_response(200)
            self.end_headers()

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


def test_g5_transport():
    _Handler.seen = []
    with local_server() as base:
        check("g5 transport: 302 first hop not followed", g5.http_status(base + "/redir") == 302)
        check("g5 transport: browser UA sent",
              g5.http_status(base + "/") == 200 and _Handler.seen[-1][1] == g5.PROBE_UA)
        check("g5 transport: 403 recorded as measured",
              g5.http_status(base + "/forbidden", sleep=lambda s: None) == 403)
        _Handler.flaky_hits = 0
        record = []
        check("g5 transport: transient 503 retried",
              g5.http_status(base + "/flaky", record=record, sleep=lambda s: None) == 200
              and [r.get("status") for r in record] == [503, 503, 200])
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        dead = sock.getsockname()[1]
    check("g5 transport: unreachable returns -1",
          g5.http_status(f"http://127.0.0.1:{dead}/", sleep=lambda s: None) == -1)


START = "2026-11-19T00:00:00+00:00"
END = "2026-11-20T00:00:00+00:00"


def window_fixture(**overrides):
    base = {
        "start": START,
        "scheduled_end": END,
        "failClosed": True,
        "manualInterventions": 0,
        "wakes": [
            {"at": "2026-11-19T00:00:00+00:00", "source": "local-scheduler",
             "officialRunId": "run-1", "approvalPrompts": 0},
            {"at": "2026-11-19T13:00:00+00:00", "source": "local-scheduler",
             "officialRunId": "run-2", "approvalPrompts": 0},
            {"at": "2026-11-20T00:00:00+00:00", "source": "local-scheduler",
             "officialRunId": "run-3", "approvalPrompts": 0},
        ],
    }
    base.update(overrides)
    return {"new_window": base}


@contextlib.contextmanager
def patched_g5(td, window, *, at, scheduler_ok=True, prior=None):
    window_path = pathlib.Path(td) / "g5-window.json"
    verdict_path = pathlib.Path(td) / "g5-verdict.json"
    write_json(window_path, window)
    if prior is not None:
        write_json(verdict_path, prior)
    saved = {key: getattr(g5, key) for key in
             ("WINDOW", "VERDICT", "WAKES", "now", "scheduler_alive", "HEALTH_URL")}
    g5.WINDOW = window_path
    g5.VERDICT = verdict_path
    g5.WAKES = None
    g5.HEALTH_URL = ""
    g5.now = lambda: at
    g5.scheduler_alive = lambda: {"ok": scheduler_ok, "label": "test"}
    try:
        yield window_path, verdict_path
    finally:
        for key, value in saved.items():
            setattr(g5, key, value)


def test_g5_window_logic():
    from datetime import datetime
    after = datetime.fromisoformat("2026-11-20T00:05:00+00:00")
    early = datetime.fromisoformat("2026-11-19T12:00:00+00:00")

    with tempfile.TemporaryDirectory() as td:
        with patched_g5(td, window_fixture(), at=early) as (_, verdict):
            rc = g5.main([])
            check("g5 window: early exit 0", rc == 0)
            check("g5 window: no verdict before end", not verdict.exists())

    with tempfile.TemporaryDirectory() as td:
        with patched_g5(td, window_fixture(), at=after) as (_, verdict):
            rc = g5.main([])
            record = json.loads(verdict.read_text())
            check("g5 window: valid window passes", rc == 0 and record["verdict"] == "PASSED",
                  record.get("checks"))
            check("g5 window: six frozen criteria",
                  len([k for k in record["checks"] if k.startswith("G5_C")]) == 6)
            check("g5 window: single-root disclosure present",
                  "single-root" in record["singleRootDisclosure"])

    with tempfile.TemporaryDirectory() as td:
        with patched_g5(td, window_fixture(wakes=[]), at=after) as (_, verdict):
            rc = g5.main([])
            record = json.loads(verdict.read_text())
            check("g5 window: missing wakes FAILED",
                  rc == 1 and record["checks"]["G5_C2_local_scheduled_wakes_ge_3"] is False)

    with tempfile.TemporaryDirectory() as td:
        with patched_g5(td, window_fixture(failClosed=False), at=after) as (_, verdict):
            rc = g5.main([])
            record = json.loads(verdict.read_text())
            check("g5 window: failClosed=false FAILED",
                  rc == 1 and record["checks"]["G5_C5_fail_closed_no_fatal"] is False)

    with tempfile.TemporaryDirectory() as td:
        short = window_fixture()
        short["new_window"]["wakes"] = short["new_window"]["wakes"][:2]
        with patched_g5(td, short, at=after) as (_, verdict):
            rc = g5.main([])
            record = json.loads(verdict.read_text())
            check("g5 window: <3 wakes FAILED",
                  rc == 1 and record["checks"]["G5_C2_local_scheduled_wakes_ge_3"] is False)

    with tempfile.TemporaryDirectory() as td:
        fatal = window_fixture()
        fatal["new_window"]["wakes"][0]["fatal"] = True
        with patched_g5(td, fatal, at=after) as (_, verdict):
            rc = g5.main([])
            record = json.loads(verdict.read_text())
            check("g5 window: fatal wake FAILED",
                  rc == 1 and record["checks"]["G5_C5_fail_closed_no_fatal"] is False)

    # Existing verdict for the same window is not overwritten.
    with tempfile.TemporaryDirectory() as td:
        prior = {"window_start": START, "verdict": "FAILED"}
        with patched_g5(td, window_fixture(), at=after, prior=prior) as (_, verdict):
            rc = g5.main([])
            check("g5 window: same-window guard", rc == 0 and json.loads(verdict.read_text()) == prior)

    # Coexistence: a production verdict path is a different file and untouched.
    with tempfile.TemporaryDirectory() as td:
        production = pathlib.Path(td) / "OBSERVATION_WINDOW_VERDICT.json"
        write_json(production, {"window_start": "production", "verdict": "PASSED"})
        before = production.read_text()
        with patched_g5(td, window_fixture(), at=after) as (_, verdict):
            g5.main([])
            check("g5 window: coexists with production verdict path",
                  production.read_text() == before and verdict.exists())

    # Invalid wake sources are rejected, not silently counted.
    invalid = window_fixture()
    invalid["new_window"]["wakes"][2]["source"] = "scheduled-cloud"
    result = g5.validate_wakes(invalid["new_window"]["wakes"], g5.LAUNCHD_LABEL)
    check("g5 window: non-local wake source rejected",
          result["count"] == 2 and result["invalid"])


def main():
    test_keygen()
    test_exporter()
    test_verifier()
    test_g5_transport()
    test_g5_window_logic()
    failed = [name for name, ok in RESULTS if not ok]
    print(f"\nRESULT: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS"
          + (f"  FAILURES: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())