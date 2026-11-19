#!/usr/bin/env python3
"""Tests for closed_loop_status.py (闭环 C 收口). Fail-closed + T2 OFF derivation.

Run: python3 -I test_closed_loop_status.py
Uses temp dirs + env overrides; never touches live artifacts.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import closed_loop_status as cls  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS ", name)
    else:
        FAIL += 1
        print("FAIL ", name)


def write(td, name, obj):
    p = pathlib.Path(td) / name
    p.write_text(json.dumps(obj))
    return p


def main():
    with tempfile.TemporaryDirectory() as td:
        # 1. Missing inputs -> unknown / deferred, never positive assertion.
        os.environ["BANDROOM_WINDOW_JSON"] = str(pathlib.Path(td) / "nope.json")
        os.environ["BANDROOM_RUNNER_STATE"] = str(pathlib.Path(td) / "nope2.json")
        os.environ["BANDROOM_T2_COUNTS"] = str(pathlib.Path(td) / "nope3.json")
        os.environ["BANDROOM_G5_CHECK"] = str(pathlib.Path(td) / "nope4.json")
        os.environ["BANDROOM_CG_RESULT"] = str(pathlib.Path(td) / "nope5.json")
        s = cls.build_status()
        check("missing window -> unknown", s["production_window"]["status"] == "unknown")
        check("missing runner -> unknown", s["runner"]["status"] == "unknown")
        check("missing t2 counts -> unknown", s["t2_calibration"]["t2"] == "unknown")
        check("missing g5 -> unknown", s["g5_owner_attested"]["status"] == "unknown")
        check("missing cg -> deferred (not fabricated)", s["cg_calibration_gate"]["status"] == "deferred")
        check("fail_closed flag", s["fail_closed"] is True)

        # 2. T2 OFF when adequacy floor not met (2 sessions / 1 future).
        counts = write(td, "counts.json", {
            "sessions": {"recordingsWithCandidates": 2},
            "candidates": {"total": 4, "future": 1, "catchTrials": 0},
        })
        os.environ["BANDROOM_T2_COUNTS"] = str(counts)
        t2 = cls.t2_state()
        check("adequacy not met (2 sessions)", t2["adequacy_met"] is False)
        check("T2 RETIRED when floor not met", t2["t2"].startswith("RETIRED"))
        check("T2 retired flag set", t2["retired"] is True)
        check("floor values reported", t2["adequacy_floor"]["min_sessions"] == 4
              and t2["adequacy_floor"]["min_future_candidates"] == 20)

        # 3. Even when floor met, T2 stays retired; aggregator never asserts unlock.
        counts2 = write(td, "counts2.json", {
            "sessions": {"recordingsWithCandidates": 5},
            "candidates": {"total": 40, "future": 25, "catchTrials": 6},
        })
        os.environ["BANDROOM_T2_COUNTS"] = str(counts2)
        t2b = cls.t2_state()
        check("adequacy met (5 sessions/25 future)", t2b["adequacy_met"] is True)
        check("floor met still RETIRED (no unlock asserted)",
              t2b["t2"].startswith("RETIRED"))

        # 4. Runner health read correctly.
        rstate = write(td, "runner.json", {
            "lastRun": {"fatal": False, "processed": 0, "failed": 0, "detail": "processed=0"},
            "cost": {"spentCny": 0.5, "utcDay": "2026-11-19", "paused": False},
        })
        os.environ["BANDROOM_RUNNER_STATE"] = str(rstate)
        rn = cls.runner_state()
        check("runner fatal read", rn["last_run_fatal"] is False)
        check("runner cost read", rn["cost_spent_cny_today"] == 0.5)

        # 5. Window verdict read.
        win = write(td, "win.json", {"new_window": {
            "start": "2026-11-19T12:50:44Z", "scheduled_end": "2026-11-20T12:50:44Z",
            "worker_version": "57c29329", "verdict": "IN PROGRESS"}})
        os.environ["BANDROOM_WINDOW_JSON"] = str(win)
        pw = cls.window_state()
        check("window worker read", pw["worker_version"] == "57c29329")
        check("window verdict read", pw["verdict"] == "IN PROGRESS")

        # 6. Markdown renders without crashing and contains key sections.
        md = cls.render_markdown(cls.build_status())
        check("markdown has T2 section", "## T2 个人校准" in md)
        check("markdown has maintenance section", "残留 owner 维护项" in md)
        check("markdown fail-closed note", "fail-closed" in md)

        # 7. main() writes artifacts to --out.
        outdir = pathlib.Path(td) / "out"
        rc = cls.main(["--out", str(outdir)])
        check("main returns 0", rc == 0)
        check("main wrote latest json", (outdir / "closed-loop-status-latest.json").exists())
        check("main wrote dated md", any(outdir.glob("closed-loop-status-*.md")))

    print(f"\nRESULT: {PASS}/{PASS + FAIL} PASS")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
