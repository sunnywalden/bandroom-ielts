#!/usr/bin/env python3
"""Tests for the NON-GATE mechanism simulation.

The simulation must exercise the V3-P feature subset, label itself non-gate,
never run V3-G on sentence-block splits, and never write V3_GATE_RESULT.json.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

B = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(B))

import mechanism_simulation as sim  # noqa: E402

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


def main():
    payload = sim.simulate()

    check("simulation labels itself non-gate", payload["nonGate"] is True)
    check("status string says NON-GATE", "NON-GATE" in payload["status"])
    check("simulation never writes a gate result",
          payload["writesGateResult"] is False and payload["gateResultPath"] is None)
    check("no V3-G run on sentence blocks",
          payload["v3gRunOnSentenceBlocks"] is False)
    check("replication unit is not sentence-block",
          "sentence-block" in payload["replication"].lower())
    check("V3-G catch-trial gap is documented",
          "catch trials" in payload["v3gCatchTrialNote"]
          and "V3-P" in payload["v3gCatchTrialNote"])
    check("power-loss disclosure is present", bool(payload["powerLossDisclosure"]))
    check("speaker disjointness is disclosed", bool(payload["speakerDisjointness"]))

    mechanism = payload["mechanism"]
    check("candidates were generated", mechanism["candidates"] > 0)
    check("verdicts were generated", mechanism["verdicts"] > 0)
    check("catch trials were generated", mechanism["catchTrials"] > 0)
    check("profile promotion selected the dominant class",
          ["DH", "D"] in mechanism["promotedClasses"],
          json.dumps(mechanism["promotedClasses"]))
    check("pooled statistics are reported",
          mechanism["t2Count"] and mechanism["t2Precision"] is not None
          and mechanism["t2WilsonLb"] is not None)

    result = payload["v3pResult"]
    check("V3-P mechanism ran on synthetic data", result.get("executed") is True,
          json.dumps(result.get("refusal_reason")))
    check("synthetic strong corpus reaches the pooled PASS path",
          result.get("PASS") is True, json.dumps(result.get("criteria")))

    # Determinism.
    check("same seed -> identical simulation payload",
          sim.simulate() == sim.simulate())

    # The constant-confirmer mechanism path must refuse, proving catch trials
    # are actually exercised (a V3-P feature, absent from V3-G).
    confirmer = sim.simulate(listener="constant-confirmer")
    check("constant-confirmer simulation is refused",
          confirmer["v3pResult"].get("executed") is False)
    check("refusal names the constant confirmer",
          any("constant confirmer" in p for p in
              confirmer["v3pResult"].get("refusal_reason", [])))

    # CLI surface: run in a temp cwd and prove no gate file appears.
    with tempfile.TemporaryDirectory() as td:
        cwd = pathlib.Path(td)
        proc = subprocess.run([sys.executable, "-I", str(B / "mechanism_simulation.py")],
                              capture_output=True, text=True, cwd=cwd)
        check("CLI exits 0", proc.returncode == 0, proc.stderr)
        try:
            cli_payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            cli_payload = {}
        check("CLI output is non-gate", cli_payload.get("nonGate") is True)
        check("CLI never creates V3_GATE_RESULT.json",
              not (cwd / "V3_GATE_RESULT.json").exists())

        out = cwd / "mechanism.json"
        proc = subprocess.run([sys.executable, "-I", str(B / "mechanism_simulation.py"),
                               "--output", str(out)],
                              capture_output=True, text=True, cwd=cwd)
        check("CLI writes only the requested non-gate artifact",
              proc.returncode == 0 and out.exists()
              and not (cwd / "V3_GATE_RESULT.json").exists(), proc.stderr)

        forbidden = cwd / "V3_GATE_RESULT.json"
        proc = subprocess.run([sys.executable, "-I", str(B / "mechanism_simulation.py"),
                               "--output", str(forbidden)],
                              capture_output=True, text=True, cwd=cwd)
        check("CLI refuses to write V3_GATE_RESULT.json",
              proc.returncode != 0 and not forbidden.exists(), proc.stderr)

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\nRESULT: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS"
          + (f"  FAILURES: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())