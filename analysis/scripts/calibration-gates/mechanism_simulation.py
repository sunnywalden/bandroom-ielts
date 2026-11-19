#!/usr/bin/env python3
"""NON-GATE mechanism simulation for the V3-P feature subset.

THIS TOOL IS NOT A GATE AND AUTHORIZES NOTHING.  It exercises the V3-P
mechanism end to end on synthetic data only:

    candidate -> verdict -> profile promotion -> catch-trial handling
              -> pooled statistics

and prints a result explicitly labelled ``NON-GATE SIMULATION``.  It NEVER
writes ``V3_GATE_RESULT.json`` and refuses to be pointed at that filename.

Three pre-registered constraints from iteration-27 §4.4 / §8 are enforced here:

* V3-G is NOT run on sentence-block splits.  Splitting a single recording into
  sentence blocks is pseudo-replication (blocks within a recording are
  correlated), so no sentence-block split is constructed at all.  The unit of
  replication is the session.
* V3-G does not check catch trials; catch-trial behaviour is a V3-P feature.
  This simulation therefore exercises V3-P only and says so in its output.
* The synthetic speakers are generated here and are disjoint by construction
  from any CG calibration speaker set; no owner data is read.  Because the
  simulation is synthetic, it carries no inferential power for the real gate;
  that power loss is disclosed in the output.

Usage:
  python3 -I mechanism_simulation.py
  python3 -I mechanism_simulation.py --listener constant-confirmer
  python3 -I mechanism_simulation.py --output simulation.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import v3_gate as v3g  # noqa: E402
import v3_personal_gate as v3p  # noqa: E402

NON_GATE_STATUS = "NON-GATE SIMULATION — DOES NOT AUTHORIZE ANY UNLOCK"
FORBIDDEN_OUTPUT_NAME = "V3_GATE_RESULT.json"
SIMULATION_SEED = 20261119

V3G_CATCH_TRIAL_NOTE = (
    "V3-G does not check catch trials; catch-trial behaviour is a V3-P "
    "feature. This simulation exercises V3-P only and does not run V3-G."
)
REPLICATION_NOTE = (
    "Replication unit is the session. No sentence-block split is constructed; "
    "splitting one recording into sentence blocks would be pseudo-replication."
)


def _candidate(cid, expected, actual, true_error, at):
    return {
        "candidateId": cid,
        "word": "they",
        "expected": expected,
        "actual": actual,
        "atMs": at,
        "detectorConfidence": 0.9,
        "groundTruth": {"isTrueError": bool(true_error), "annotatedBy": "human",
                        "intervalStartMs": at, "intervalEndMs": at + 120},
    }


def _history_session(session_id, day, rng):
    """A short history session whose first verdicts promote the DH/D class."""
    candidates = []
    verdicts = []
    # The first eight verdicts are the frozen fit: six true errors in the
    # dominant class and two correct items in a second class.
    design = [("DH", "D", True)] * 6 + [("TH", "S", False)] * 2
    for index, (expected, actual, truth) in enumerate(design):
        cid = f"{session_id}_c{index}"
        candidates.append(_candidate(cid, expected, actual, truth, 1000 * index))
        verdicts.append({"candidateId": cid,
                         "verdict": "confirmed" if truth else "rejected",
                         "isCatchTrial": False})
    for index in range(2):
        cid = f"{session_id}_ctl{index}"
        candidates.append(_candidate(cid, "DH", "D", True, 50000 + index))
        verdicts.append({"candidateId": cid, "verdict": "rejected",
                         "isCatchTrial": True})
    _ = rng  # reserved for future synthetic variation; deterministic today
    return {"sessionId": session_id,
            "recordedAt": f"2026-11-{day:02d}T00:00:00Z",
            "audioSha256": "s" * 64, "speechSeconds": 60.0,
            "candidates": candidates, "verdicts": verdicts}


def _future_session(session_id, day, rng, n_dominant=18, n_other=6):
    """A future session with a strong dominant class and a weaker second class."""
    candidates = []
    verdicts = []
    index = 0
    for _ in range(n_dominant):
        cid = f"{session_id}_g{index}"
        candidates.append(_candidate(cid, "DH", "D", True, 1000 * index))
        index += 1
    for _ in range(n_other):
        cid = f"{session_id}_b{index}"
        candidates.append(_candidate(cid, "TH", "S", False, 1000 * index))
        index += 1
    for control in range(2):
        cid = f"{session_id}_ctl{control}"
        candidates.append(_candidate(cid, "DH", "D", True, 90000 + control))
        verdicts.append({"candidateId": cid, "verdict": "rejected",
                         "isCatchTrial": True})
    _ = rng  # deterministic today; kept for documented future variation
    return {"sessionId": session_id,
            "recordedAt": f"2026-11-{day:02d}T00:00:00Z",
            "audioSha256": "f" * 64, "speechSeconds": 60.0,
            "candidates": candidates, "verdicts": verdicts}


def build_document(listener: str, seed: int) -> dict:
    rng = random.Random(seed)
    sessions = [
        _history_session("s0", 10, rng),
        _history_session("s1", 11, rng),
        _future_session("s2", 12, rng),
        _future_session("s3", 13, rng),
    ]
    if listener == "constant-confirmer":
        for session in sessions:
            for verdict in session["verdicts"]:
                if verdict.get("isCatchTrial"):
                    verdict["verdict"] = "confirmed"
    elif listener != "discriminating":
        raise ValueError(f"unknown listener model: {listener!r}")
    return {"schema": v3g.SCHEMA["schema"],
            "users": [{"userId": "simulation-user", "sessions": sessions}]}


def simulate(listener: str = "discriminating", seed: int = SIMULATION_SEED) -> dict:
    """Run the V3-P mechanism on synthetic data and label the result non-gate."""
    document = build_document(listener, seed)
    result = v3p.evaluate_user(document, "simulation-user")
    sessions = document["users"][0]["sessions"]
    candidates = [c for s in sessions for c in (s.get("candidates") or [])]
    verdicts = [v for s in sessions for v in (s.get("verdicts") or [])]
    controls = [v for v in verdicts if v.get("isCatchTrial")]
    return {
        "status": NON_GATE_STATUS,
        "nonGate": True,
        "writesGateResult": False,
        "gateResultPath": None,
        "purpose": "Exercise the V3-P feature subset on synthetic data only; "
                   "this output cannot authorize T2 or any product claim.",
        "replication": REPLICATION_NOTE,
        "v3gRunOnSentenceBlocks": False,
        "v3gCatchTrialNote": V3G_CATCH_TRIAL_NOTE,
        "speakerDisjointness": (
            "Synthetic speakers generated in-process; disjoint by construction "
            "from any CG calibration speaker set. No owner/CG data is read."),
        "powerLossDisclosure": (
            "Synthetic data has no inferential power for the real gate. This is "
            "a mechanism check, not a powered evaluation; the frozen gate must "
            "still be run once on real data."),
        "listenerModel": listener,
        "seed": seed,
        "mechanism": {
            "sessions": len(sessions),
            "candidates": len(candidates),
            "verdicts": len(verdicts),
            "catchTrials": len(controls),
            "determinateControls": sum(1 for v in controls
                                       if v.get("verdict") in ("confirmed", "rejected")),
            "fitVerdictsUsed": result.get("fit_verdicts_used"),
            "promotedClasses": result.get("promoted_classes"),
            "t2Count": result.get("t2_count"),
            "t2Precision": result.get("t2_precision"),
            "t2WilsonLb": result.get("t2_wilson_lb"),
            "tpRetention": result.get("tp_retention"),
            "pooledPass": result.get("PASS"),
        },
        "v3pResult": result,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listener", choices=["discriminating", "constant-confirmer"],
                        default="discriminating")
    parser.add_argument("--seed", type=int, default=SIMULATION_SEED)
    parser.add_argument("--output", type=pathlib.Path, default=None,
                        help="optional JSON output path (never V3_GATE_RESULT.json)")
    args = parser.parse_args()

    if args.output is not None:
        if args.output.name == FORBIDDEN_OUTPUT_NAME:
            print(f"refusing to write {FORBIDDEN_OUTPUT_NAME}: this tool is "
                  "NON-GATE and must never emit a gate result", file=sys.stderr)
            return 2
        args.output.parent.mkdir(parents=True, exist_ok=True)

    payload = simulate(args.listener, args.seed)

    if args.output is not None:
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        print(f"NON-GATE simulation written to {args.output}")
        print("This artifact is NOT a gate result and authorizes nothing.")
        return 0

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())