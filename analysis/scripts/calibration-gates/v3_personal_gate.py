#!/usr/bin/env python3
"""V3-P: single-user personal calibration gate.

PRE-REGISTERED in iteration-25/V3P_PREREGISTRATION.md, frozen before any real
multi-session data existed.

Why this exists separately from V3-G (v3_gate.py):
T2's actual claim is per-user — "your history suggests this class". V3-G asks a
different question (does the mechanism generalize ACROSS users) and requires
>= 6 users, which binds a technical capability to user acquisition. That was a
category error. V3-P answers the per-user question with that user's own data.

This is NOT a relaxation. Every statistical threshold is imported from v3_gate
so it cannot drift. What changes is the unit of analysis (one user, not a
cohort) and the level of replication (SESSIONS, not candidates — candidates
within one recording are correlated, which is the single-user analogue of the
pseudo-replication error that sank rev1).

A PASS enables T2 FOR THIS USER ONLY. It is never a product-wide claim and
never enables T2 by default for new users; that still requires V3-G.

Usage:
  python v3_personal_gate.py check <data.json> <userId>
  python v3_personal_gate.py evaluate <data.json> <userId>
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import defaultdict

# `python3 -I` implies -P, which keeps the script's own directory off sys.path.
# Add it explicitly so the frozen V3-G module can be imported under isolation.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# Import the frozen constants and the exact statistical helpers from V3-G so
# the two gates cannot diverge. Editing a threshold here is impossible.
from v3_gate import (  # noqa: E402
    FROZEN_N,
    FROZEN_PROMOTE_POSTERIOR_LB,
    FROZEN_PRIOR_BASE_RATE,
    T2_ABS_PRECISION,
    T2_LB_FLOOR,
    TP_RETENTION_MIN,
    MIN_FUTURE_CANDIDATES,
    SCHEMA,
    beta_ppf_10,
    wilson_lb,
)

# ---- FROZEN V3-P PRE-REGISTRATION (do not edit to make a result pass) ----
MIN_HISTORY_SESSIONS = 2
MIN_FUTURE_SESSIONS = 2
CATCH_TRIAL_MIN_ANSWERED = 5
CATCH_TRIAL_CONFIRM_RATE = 0.80
# --------------------------------------------------------------------------


def _split(sessions: list[dict]) -> tuple[list[dict], list[dict]]:
    """History = all but the last MIN_FUTURE_SESSIONS; future = the last ones."""
    return sessions[:-MIN_FUTURE_SESSIONS], sessions[-MIN_FUTURE_SESSIONS:]


def check_user(data: dict, user_id: str) -> tuple[bool, list[str], dict | None]:
    problems: list[str] = []
    if data.get("schema") != SCHEMA["schema"]:
        problems.append(f"schema must be {SCHEMA['schema']}")
    user = next((u for u in (data.get("users") or []) if u.get("userId") == user_id), None)
    if user is None:
        problems.append(f"user {user_id} not present in the document")
        return False, problems, None

    sessions = user.get("sessions") or []
    needed = MIN_HISTORY_SESSIONS + MIN_FUTURE_SESSIONS
    if len(sessions) < needed:
        problems.append(
            f"needs >= {MIN_HISTORY_SESSIONS} history + {MIN_FUTURE_SESSIONS} future "
            f"sessions ({needed} total), got {len(sessions)}. SINGLE-SESSION DATA "
            f"CANNOT VALIDATE CROSS-SESSION CALIBRATION.")
        return False, problems, None

    times = [s.get("recordedAt") for s in sessions]
    if times != sorted(times):
        problems.append("sessions are not strictly time-ordered")
    if len(set(times)) != len(times):
        problems.append("sessions share a recordedAt; temporal split is ambiguous")

    history, future = _split(sessions)
    future_candidates = [c for s in future for c in (s.get("candidates") or [])]
    if len(future_candidates) < MIN_FUTURE_CANDIDATES:
        problems.append(f"future sessions have {len(future_candidates)} candidates, "
                        f"need >= {MIN_FUTURE_CANDIDATES}")
    for c in future_candidates:
        gt = c.get("groundTruth") or {}
        if gt.get("annotatedBy") != "human":
            problems.append("every future candidate needs HUMAN ground truth; "
                            "detector labels are refused")
            break

    controls = [v for s in sessions for v in (s.get("verdicts") or []) if v.get("isCatchTrial")]
    if not controls:
        problems.append("no catch trials recorded; the gate requires them")
    else:
        answered = len(controls)
        confirmed = sum(1 for v in controls if v.get("verdict") == "confirmed")
        if answered >= CATCH_TRIAL_MIN_ANSWERED and confirmed / answered >= CATCH_TRIAL_CONFIRM_RATE:
            problems.append(f"constant confirmer: {confirmed}/{answered} controls confirmed; "
                            f"verdicts are uninformative")

    return (not problems), problems, user


def evaluate_user(data: dict, user_id: str) -> dict:
    ok, problems, user = check_user(data, user_id)
    if not ok:
        return {"executed": False, "userId": user_id, "refusal_reason": problems,
                "note": "V3-P REFUSES TO RUN. Inadequate or single-session data cannot "
                        "validate cross-session personal calibration."}

    sessions = user["sessions"]
    history, future = _split(sessions)

    verdicts = []
    for s in history:
        cmap = {c["candidateId"]: c for c in (s.get("candidates") or [])}
        for v in s.get("verdicts") or []:
            if v.get("isCatchTrial"):
                continue
            c = cmap.get(v["candidateId"])
            if c:
                verdicts.append((c, v["verdict"]))
    fit = verdicts[:FROZEN_N]
    counts: dict[tuple, list[int]] = defaultdict(lambda: [0, 0])
    for c, v in fit:
        key = (c["expected"], c["actual"])
        if v == "confirmed":
            counts[key][0] += 1
        elif v == "rejected":
            counts[key][1] += 1
    promoted = {k for k, (c, r) in counts.items()
                if beta_ppf_10(c, r) >= FROZEN_PROMOTE_POSTERIOR_LB}

    per_session = []
    for s in future:
        fc = s.get("candidates") or []
        if not fc:
            continue
        base_tp = sum(1 for c in fc if c["groundTruth"]["isTrueError"])
        t2 = [c for c in fc if (c["expected"], c["actual"]) in promoted]
        t2_tp = sum(1 for c in t2 if c["groundTruth"]["isTrueError"])
        per_session.append({
            "sessionId": s.get("sessionId"),
            "future_candidates": len(fc),
            "baseline_precision": base_tp / len(fc),
            "t2_count": len(t2),
            "t2_tp": t2_tp,
            "t2_precision": (t2_tp / len(t2)) if t2 else None,
            "consistent": bool(t2) and (t2_tp / len(t2)) >= (base_tp / len(fc)),
        })

    all_future = [c for s in future for c in (s.get("candidates") or [])]
    base_tp = sum(1 for c in all_future if c["groundTruth"]["isTrueError"])
    t2_all = [c for c in all_future if (c["expected"], c["actual"]) in promoted]
    t2_tp = sum(1 for c in t2_all if c["groundTruth"]["isTrueError"])
    t2_precision = (t2_tp / len(t2_all)) if t2_all else None
    lb = wilson_lb(t2_tp, len(t2_all))
    retention = (t2_tp / base_tp) if base_tp else None

    with_t2 = [s for s in per_session if s["t2_count"] > 0]
    consistent = sum(1 for s in with_t2 if s["consistent"])

    per_class = []
    for key in sorted(promoted):
        occ = [c for c in all_future if (c["expected"], c["actual"]) == key]
        tp = sum(1 for c in occ if c["groundTruth"]["isTrueError"])
        per_class.append({"expected": key[0], "actual": key[1],
                          "future_occurrences": len(occ), "true_errors": tp,
                          "precision": (tp / len(occ)) if occ else None,
                          "wilson_lb": wilson_lb(tp, len(occ))})

    criteria = {
        "t2_absolute": bool(t2_precision is not None and t2_precision >= T2_ABS_PRECISION),
        "t2_lb": bool(lb is not None and lb >= T2_LB_FLOOR),
        "tp_retention": bool(retention is not None and retention >= TP_RETENTION_MIN),
        "multi_session_evidence": len(with_t2) >= MIN_FUTURE_SESSIONS,
        "session_consistency": bool(with_t2) and consistent * 2 >= len(with_t2),
    }
    passed = all(criteria.values())
    return {
        "executed": True,
        "gate": "V3-P",
        "userId": user_id,
        "claim_scope": "THIS USER ONLY — not a product-wide claim; "
                       "new users still require V3-G",
        "frozen": {"N": FROZEN_N, "promote_lb": FROZEN_PROMOTE_POSTERIOR_LB,
                   "prior_base": FROZEN_PRIOR_BASE_RATE,
                   "t2_abs": T2_ABS_PRECISION, "t2_lb": T2_LB_FLOOR,
                   "tp_retention": TP_RETENTION_MIN,
                   "min_history_sessions": MIN_HISTORY_SESSIONS,
                   "min_future_sessions": MIN_FUTURE_SESSIONS},
        "history_sessions": len(history),
        "future_sessions": len(future),
        "fit_verdicts_used": len(fit),
        "promoted_classes": sorted(map(list, promoted)),
        "future_candidates": len(all_future),
        "baseline_precision": (base_tp / len(all_future)) if all_future else None,
        "t2_count": len(t2_all),
        "t2_tp": t2_tp,
        "t2_precision": t2_precision,
        "t2_wilson_lb": lb,
        "tp_retention": retention,
        "per_future_session": per_session,
        "per_promoted_class": per_class,
        "criteria": criteria,
        "PASS": passed,
        "consequence": (
            "T2 MAY be enabled FOR THIS USER ONLY, per class, with personal "
            "hedging retained; re-validate continuously and demote on new evidence."
            if passed else
            "T2 MUST STAY DISABLED for this user; product remains T1+T3. "
            "No constant may be adjusted to make this pass."),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=["check", "evaluate"])
    ap.add_argument("data")
    ap.add_argument("user_id")
    a = ap.parse_args()
    document = json.loads(pathlib.Path(a.data).read_text())
    if a.mode == "check":
        ok, problems, _ = check_user(document, a.user_id)
        print(json.dumps({"adequate": ok, "problems": problems}, ensure_ascii=False, indent=2))
        return 0 if ok else 1
    result = evaluate_user(document, a.user_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("PASS") else 1


if __name__ == "__main__":
    sys.exit(main())
