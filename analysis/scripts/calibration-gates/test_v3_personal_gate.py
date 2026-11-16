#!/usr/bin/env python3
"""Tests for V3-P, the single-user personal calibration gate.

The point of these tests is that V3-P is NOT a relaxation: it must refuse the
same inadequate data V3-G refuses, use identical thresholds, and additionally
refuse a result driven by a single future session (the single-user analogue of
the pseudo-replication error that sank rev1).
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile

B = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("v3p", B / "v3_personal_gate.py")
v3p = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(B))
spec.loader.exec_module(v3p)
import v3_gate as v3g  # noqa: E402

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


def candidate(cid, expected="DH", actual="D", true_error=True, at=1000):
    return {"candidateId": cid, "word": "they", "expected": expected, "actual": actual,
            "atMs": at, "detectorConfidence": 0.9,
            "groundTruth": {"isTrueError": true_error, "annotatedBy": "human",
                            "intervalStartMs": at, "intervalEndMs": at + 120}}


def session(sid, day, candidates, verdicts=None, controls=0):
    verdicts = list(verdicts or [])
    for i in range(controls):
        verdicts.append({"candidateId": f"{sid}_ctl{i}", "verdict": "rejected",
                         "isCatchTrial": True})
    return {"sessionId": sid, "recordedAt": f"2026-11-{day:02d}T00:00:00Z",
            "audioSha256": "a" * 64, "speechSeconds": 60.0,
            "candidates": candidates, "verdicts": verdicts}


def history_session(sid, day, n=4):
    cands = [candidate(f"{sid}_c{i}", at=1000 * i) for i in range(n)]
    verdicts = [{"candidateId": c["candidateId"], "verdict": "confirmed",
                 "isCatchTrial": False} for c in cands]
    return session(sid, day, cands, verdicts, controls=2)


def future_session(sid, day, n_good=10, n_bad=2):
    cands = [candidate(f"{sid}_g{i}", at=1000 * i) for i in range(n_good)]
    cands += [candidate(f"{sid}_b{i}", expected="TH", actual="S",
                        true_error=False, at=20000 + 1000 * i) for i in range(n_bad)]
    return session(sid, day, cands, controls=2)


def doc(sessions, user="u1"):
    return {"schema": v3g.SCHEMA["schema"], "users": [{"userId": user, "sessions": sessions}]}


def adequate_doc():
    return doc([history_session("h0", 10), history_session("h1", 11),
                future_session("f0", 12), future_session("f1", 13)])


def main():
    # Thresholds must be the very same objects V3-G uses.
    check("T2 absolute floor identical to V3-G", v3p.T2_ABS_PRECISION == v3g.T2_ABS_PRECISION)
    check("T2 Wilson floor identical to V3-G", v3p.T2_LB_FLOOR == v3g.T2_LB_FLOOR)
    check("TP retention identical to V3-G", v3p.TP_RETENTION_MIN == v3g.TP_RETENTION_MIN)
    check("fit N identical to V3-G", v3p.FROZEN_N == v3g.FROZEN_N)
    check("promotion posterior identical to V3-G",
          v3p.FROZEN_PROMOTE_POSTERIOR_LB == v3g.FROZEN_PROMOTE_POSTERIOR_LB)
    check("prior base rate identical to V3-G",
          v3p.FROZEN_PRIOR_BASE_RATE == v3g.FROZEN_PRIOR_BASE_RATE)
    check("wilson helper is the same function", v3p.wilson_lb is v3g.wilson_lb)
    check("beta helper is the same function", v3p.beta_ppf_10 is v3g.beta_ppf_10)

    # Refusals.
    ok, problems, _ = v3p.check_user(doc([history_session("h0", 10)]), "u1")
    check("refuses single session", not ok)
    ok, problems, _ = v3p.check_user(
        doc([history_session("h0", 10), history_session("h1", 11),
             future_session("f0", 12)]), "u1")
    check("refuses only one future session", not ok)
    ok, problems, _ = v3p.check_user(adequate_doc(), "nobody")
    check("refuses unknown user", not ok)

    unordered = adequate_doc()
    unordered["users"][0]["sessions"].reverse()
    ok, problems, _ = v3p.check_user(unordered, "u1")
    check("refuses unordered sessions", not ok and any("time-ordered" in p for p in problems))

    detector_labelled = adequate_doc()
    detector_labelled["users"][0]["sessions"][-1]["candidates"][0]["groundTruth"]["annotatedBy"] = "detector"
    ok, problems, _ = v3p.check_user(detector_labelled, "u1")
    check("refuses detector-labelled truth", not ok and any("HUMAN" in p for p in problems))

    no_controls = adequate_doc()
    for s in no_controls["users"][0]["sessions"]:
        s["verdicts"] = [v for v in s["verdicts"] if not v.get("isCatchTrial")]
    ok, problems, _ = v3p.check_user(no_controls, "u1")
    check("refuses missing catch trials", not ok and any("catch trials" in p for p in problems))

    confirmer = adequate_doc()
    for s in confirmer["users"][0]["sessions"]:
        for v in s["verdicts"]:
            if v.get("isCatchTrial"):
                v["verdict"] = "confirmed"
    ok, problems, _ = v3p.check_user(confirmer, "u1")
    check("refuses constant confirmer", not ok and any("constant confirmer" in p for p in problems))

    thin = doc([history_session("h0", 10), history_session("h1", 11),
                future_session("f0", 12, n_good=3, n_bad=1),
                future_session("f1", 13, n_good=3, n_bad=1)])
    ok, problems, _ = v3p.check_user(thin, "u1")
    check("refuses too few future candidates", not ok)

    # evaluate refuses too, rather than silently degrading.
    refused = v3p.evaluate_user(doc([history_session("h0", 10)]), "u1")
    check("evaluate refuses inadequate data", refused.get("executed") is False)

    # A genuinely adequate, genuinely strong corpus passes.
    result = v3p.evaluate_user(adequate_doc(), "u1")
    check("evaluates adequate data", result.get("executed") is True)
    if result.get("executed"):
        check("promotes the confirmed class", ["DH", "D"] in result["promoted_classes"],
              json.dumps(result["promoted_classes"]))
        check("strong corpus passes", result["PASS"] is True, json.dumps(result["criteria"]))
        check("claim scope is user-only", "THIS USER ONLY" in result["claim_scope"])
        check("two future sessions contribute T2",
              result["criteria"]["multi_session_evidence"] is True)
        check("per-class evidence is reported", len(result["per_promoted_class"]) >= 1)

    # A single future session driving all the T2 evidence must FAIL even though
    # pooled precision is perfect. This is the tlv lesson at session level.
    single_driver = doc([history_session("h0", 10), history_session("h1", 11),
                         future_session("f0", 12, n_good=20, n_bad=2),
                         future_session("f1", 13, n_good=0, n_bad=10)])
    result = v3p.evaluate_user(single_driver, "u1")
    check("single-session driver is evaluated", result.get("executed") is True)
    if result.get("executed"):
        check("single-session driver FAILS despite perfect pooled precision",
              result["PASS"] is False, json.dumps(result["criteria"]))
        check("multi_session_evidence is the failing criterion",
              result["criteria"]["multi_session_evidence"] is False)
        check("pooled precision really is perfect", result["t2_precision"] == 1.0)

    # Weak future evidence must fail the absolute/LB floors.
    weak = adequate_doc()
    for s in weak["users"][0]["sessions"][-2:]:
        for c in s["candidates"]:
            if c["expected"] == "DH":
                c["groundTruth"]["isTrueError"] = False
    result = v3p.evaluate_user(weak, "u1")
    check("weak future evidence fails", result.get("PASS") is False)
    check("absolute floor is the failing criterion",
          result["criteria"]["t2_absolute"] is False)

    # CLI surface.
    with tempfile.TemporaryDirectory() as td:
        path = pathlib.Path(td) / "d.json"
        path.write_text(json.dumps(adequate_doc()))
        proc = subprocess.run([sys.executable, "-I", str(B / "v3_personal_gate.py"),
                               "evaluate", str(path), "u1"], capture_output=True, text=True)
        payload = json.loads(proc.stdout)
        check("CLI evaluate returns a verdict", payload.get("gate") == "V3-P")
        check("CLI exit code reflects PASS", proc.returncode == 0)
        proc = subprocess.run([sys.executable, "-I", str(B / "v3_personal_gate.py"),
                               "check", str(path), "missing"], capture_output=True, text=True)
        check("CLI check exits non-zero when inadequate", proc.returncode == 1)

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\nRESULT: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS"
          + (f"  FAILURES: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
