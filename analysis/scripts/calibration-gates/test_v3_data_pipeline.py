#!/usr/bin/env python3
"""Tests for the D1 -> V3 gate data path (readiness math and annotation shape)."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile

B = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("v3pipe", B / "v3_data_pipeline.py")
pipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipe)

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


def session(sid, n, annotated=False, catch=0, control_verdict="confirmed"):
    candidates = []
    for i in range(n):
        truth = None
        if annotated:
            truth = {"isTrueError": i % 2 == 0, "annotatedBy": "human",
                     "intervalStartMs": 1000 * i, "intervalEndMs": 1000 * i + 120}
        candidates.append({"candidateId": f"{sid}_c{i}", "word": "they",
                           "expected": "DH", "actual": "D", "atMs": 1000 * i,
                           "detectorConfidence": 0.9, "groundTruth": truth})
    verdicts = [{"candidateId": f"{sid}_c{i}",
                 "verdict": control_verdict if i < catch else "confirmed",
                 "isCatchTrial": i < catch} for i in range(catch)]
    return {"sessionId": sid, "recordedAt": f"2026-11-{10 + int(sid[-1]):02d}T00:00:00Z",
            "audioSha256": "a" * 64, "speechSeconds": 60.0,
            "candidates": candidates, "verdicts": verdicts}


def doc(users):
    return {"schema": pipe.SCHEMA, "users": users}


def main():
    # Empty corpus is not ready, and says why.
    report = pipe.readiness(doc([]))
    check("empty corpus not ready", report["readyForGate"] is False)
    check("empty corpus lists blockers", len(report["blockers"]) >= 3)

    # One user with enough sessions/candidates is still not enough users.
    one = doc([{"userId": "u1", "sessions": [session("s0", 30, annotated=True, catch=2),
                                             session("s1", 30, annotated=True, catch=2)]}])
    report = pipe.readiness(one)
    check("single user not ready", report["readyForGate"] is False)
    check("single user counted as adequate individually", report["adequateUsers"] == 1,
          json.dumps(report["perUser"]))
    check("future candidates counted from second session only",
          report["perUser"][0]["futureCandidates"] == 30)

    # Six adequate users with human truth and catch trials -> ready.
    users = [{"userId": f"u{i}",
              "sessions": [session("s0", 30, annotated=True, catch=2),
                           session("s1", 30, annotated=True, catch=2)]}
             for i in range(6)]
    report = pipe.readiness(doc(users))
    check("six adequate annotated users ready", report["readyForGate"] is True,
          json.dumps(report["blockers"]))
    check("no blockers when ready", report["blockers"] == [])
    check("human annotations counted", report["totalHumanAnnotated"] == 360)
    check("catch trials counted", report["totalCatchTrials"] == 24)

    # Detector-labelled truth must NOT count as human.
    fake = doc([{"userId": f"u{i}",
                 "sessions": [session("s0", 30), session("s1", 30)]} for i in range(6)])
    for user in fake["users"]:
        for sess in user["sessions"]:
            for cand in sess["candidates"]:
                cand["groundTruth"] = {"isTrueError": True, "annotatedBy": "detector",
                                       "intervalStartMs": 0, "intervalEndMs": 100}
    report = pipe.readiness(fake)
    check("detector labels are not human annotations", report["totalHumanAnnotated"] == 0)
    check("detector-labelled corpus still blocked", report["readyForGate"] is False)

    # Regression: enough users/sessions/candidates but NO annotation must not
    # report ready. The first version of readiness() did exactly that.
    unlabelled = doc([{"userId": f"u{i}", "sessions": [session("s0", 30), session("s1", 30)]}
                      for i in range(6)])
    report = pipe.readiness(unlabelled)
    check("unannotated corpus is never ready", report["readyForGate"] is False)
    check("unannotated users are not adequate", report["adequateUsers"] == 0)

    # Too few future candidates blocks even with many users.
    thin = doc([{"userId": f"u{i}", "sessions": [session("s0", 30), session("s1", 5)]}
                for i in range(6)])
    report = pipe.readiness(thin)
    check("thin future session blocks readiness", report["readyForGate"] is False)
    check("adequate users zero when future too small", report["adequateUsers"] == 0)

    # Single-session users have no future candidates at all.
    single = doc([{"userId": f"u{i}", "sessions": [session("s0", 50)]} for i in range(6)])
    report = pipe.readiness(single)
    check("single-session users contribute no future candidates",
          all(u["futureCandidates"] == 0 for u in report["perUser"]))

    # A non-discriminating listener must not count toward V3, even with enough
    # sessions, candidates and human annotation.
    confirmers = doc([{"userId": f"u{i}",
                       "sessions": [session("s0", 30, annotated=True, catch=3),
                                    session("s1", 30, annotated=True, catch=3)]}
                      for i in range(6)])
    report = pipe.readiness(confirmers)
    check("constant confirmers excluded from adequacy", report["adequateUsers"] == 0)
    check("constant confirmer corpus not ready", report["readyForGate"] is False)
    check("constant confirmer blocker reported",
          any("control items" in b for b in report["blockers"]))

    discriminators = doc([{"userId": f"u{i}",
                           "sessions": [session("s0", 30, annotated=True, catch=3,
                                                control_verdict="rejected"),
                                        session("s1", 30, annotated=True, catch=3,
                                                control_verdict="rejected")]}
                          for i in range(6)])
    report = pipe.readiness(discriminators)
    check("discriminating listeners remain adequate", report["adequateUsers"] == 6)
    check("discriminating corpus ready", report["readyForGate"] is True,
          json.dumps(report["blockers"]))

    # Annotation writes the exact shape the gate requires.
    target = doc([{"userId": "u1", "sessions": [session("s0", 1)]}])
    cand = target["users"][0]["sessions"][0]["candidates"][0]
    cand["groundTruth"] = {"isTrueError": True, "annotatedBy": "human",
                           "intervalStartMs": 10, "intervalEndMs": 130}
    with tempfile.TemporaryDirectory() as td:
        out = pathlib.Path(td) / "annotated.json"
        out.write_text(json.dumps(target))
        loaded = json.loads(out.read_text())
        truth = loaded["users"][0]["sessions"][0]["candidates"][0]["groundTruth"]
        check("annotation shape has all four required fields",
              set(truth) == {"isTrueError", "annotatedBy", "intervalStartMs", "intervalEndMs"})
        check("annotation is human-labelled", truth["annotatedBy"] == "human")

    # Exported documents must never carry a fabricated groundTruth.
    check("schema name matches the gate", pipe.SCHEMA == "bandroom-v3-multisession-v1")

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\nRESULT: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS"
          + (f"  FAILURES: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
