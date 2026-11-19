#!/usr/bin/env python3
"""V3 gate machinery for cross-session personal calibration (rev2 §12).

PRE-REGISTERED. Frozen before any multi-session data exists.

Why this module exists in this form: the review (BL-I) proved the existing
L2-ARCTIC Suitcase corpus has exactly ONE recording per speaker (22 files,
22 speakers), so a "history session -> future session" split is IMPOSSIBLE.
A gate that silently accepted single-session data would let a within-recording
optimistic number masquerade as cross-session validation — exactly the mistake
rev1 made. So this module REFUSES TO RUN unless the data genuinely has
multiple sessions per user.

Protocol (frozen):
  baseline      T3-only precision (no personal calibration) on the SAME
                future-session candidates of the SAME user
  metric        precision of the T2 SUBSET (classes that would be promoted),
                NOT the whole retained pool
  absolute      T2-subset precision >= 0.70, OR its 95% lower bound >= 0.70
                (OWNER-DIRECTED AMENDMENT 2026-11-19: assertion bar lowered
                 0.85->0.70. Trade-off: ~30% of assertions may be wrong, so T2
                 assertions MUST stay history-conditioned and carry a ~70%
                 reliability disclosure; never presented as certain.)
  relative      gain CI lower bound > 0  (NOT a point estimate > 0)
  retention     TP retention >= 0.50
  sample        >= 20 future-session candidates per user; >= 6 users
  frozen        a single N and a single promotion threshold; no post-hoc tiers

Usage:
  python v3_gate.py check <data.json>     # validate data adequacy, refuse if inadequate
  python v3_gate.py evaluate <data.json>  # run the frozen protocol (requires check to pass)
  python v3_gate.py schema                # print the required collection schema
"""
from __future__ import annotations
import argparse, json, math, pathlib, sys
from collections import defaultdict

# ---- PRE-REGISTRATION (owner-directed amendment 2026-11-19: bar 0.85->0.70) ----
# Not an edit-to-pass: the owner explicitly lowered the assertion bar to 0.70.
# Assertions at this bar require a ~70% reliability disclosure (see grounded_audio).
FROZEN_N = 8                    # confirmations used to fit, per user
FROZEN_PROMOTE_POSTERIOR_LB = 0.70   # Beta 10th percentile floor
FROZEN_PRIOR_BASE_RATE = 0.65      # detector measured base rate
T2_ABS_PRECISION = 0.70
T2_LB_FLOOR = 0.70
TP_RETENTION_MIN = 0.50
MIN_FUTURE_CANDIDATES = 20
MIN_USERS = 6
MATCH_TOL_S = 0.080
# --------------------------------------------------------------------

SCHEMA = {
    "schema": "bandroom-v3-multisession-v1",
    "users": [{
        "userId": "string",
        "sessions": [{
            "sessionId": "string",
            "recordedAt": "ISO8601",
            "audioSha256": "string",
            "speechSeconds": "number",
            "candidates": [{
                "candidateId": "string",
                "word": "string", "expected": "ARPABET", "actual": "ARPABET",
                "atMs": "number", "detectorConfidence": "number",
                "groundTruth": {"isTrueError": "bool", "annotatedBy": "human",
                                 "intervalStartMs": "number", "intervalEndMs": "number"}
            }],
            "verdicts": [{"candidateId": "string",
                           "verdict": "confirmed|rejected|unsure",
                           "isCatchTrial": "bool"}]
        }]
    }],
    "requirements": [
        ">= 2 sessions per user (history + future), strictly time-ordered",
        ">= 6 users",
        ">= 20 future-session candidates per user",
        "groundTruth must be HUMAN annotation, not detector output",
        "catch trials must be present and labelled"
    ]
}


def wilson_lb(k: int, n: int, z: float = 1.96) -> float | None:
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - m) / d


def beta_ppf_10(c: int, r: int, base: float = FROZEN_PRIOR_BASE_RATE) -> float:
    """10th percentile of Beta(base*2 + c, (1-base)*2 + r) by numeric inversion."""
    a = base * 2 + c
    b = (1 - base) * 2 + r
    lo, hi = 0.0, 1.0
    for _ in range(80):
        mid = (lo + hi) / 2
        # regularised incomplete beta via continued fraction (simple numeric integration)
        steps = 400
        h = mid / steps
        s = 0.0
        for i in range(steps + 1):
            x = i * h
            if x <= 0 or x >= 1:
                w = 0.0
            else:
                w = x ** (a - 1) * (1 - x) ** (b - 1)
            s += w * (1 if i in (0, steps) else (4 if i % 2 else 2))
        integral = s * h / 3
        # normalise by B(a,b) using the same rule over [0,1]
        s2 = 0.0
        h2 = 1.0 / steps
        for i in range(steps + 1):
            x = i * h2
            w = 0.0 if (x <= 0 or x >= 1) else x ** (a - 1) * (1 - x) ** (b - 1)
            s2 += w * (1 if i in (0, steps) else (4 if i % 2 else 2))
        norm = s2 * h2 / 3
        cdf = integral / norm if norm else 0.0
        if cdf < 0.10:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def check(data: dict) -> tuple[bool, list[str]]:
    problems = []
    if data.get("schema") != SCHEMA["schema"]:
        problems.append(f"schema must be {SCHEMA['schema']}")
    users = data.get("users") or []
    if len(users) < MIN_USERS:
        problems.append(f"need >= {MIN_USERS} users, got {len(users)}")
    adequate = 0
    for u in users:
        ss = u.get("sessions") or []
        if len(ss) < 2:
            problems.append(f"user {u.get('userId')}: needs >= 2 sessions, got {len(ss)} "
                            f"(SINGLE-SESSION DATA CANNOT VALIDATE CROSS-SESSION CALIBRATION)")
            continue
        times = [s.get("recordedAt") for s in ss]
        if times != sorted(times):
            problems.append(f"user {u.get('userId')}: sessions not time-ordered")
        fut = ss[-1].get("candidates") or []
        if len(fut) < MIN_FUTURE_CANDIDATES:
            problems.append(f"user {u.get('userId')}: future session has {len(fut)} candidates, "
                            f"need >= {MIN_FUTURE_CANDIDATES}")
            continue
        for c in fut:
            gt = c.get("groundTruth") or {}
            if gt.get("annotatedBy") != "human":
                problems.append(f"user {u.get('userId')}: groundTruth must be human-annotated")
                break
        else:
            adequate += 1
    if adequate < MIN_USERS:
        problems.append(f"only {adequate} users meet all requirements, need >= {MIN_USERS}")
    return (not problems), problems


def evaluate(data: dict) -> dict:
    ok, problems = check(data)
    if not ok:
        return {"executed": False, "refusal_reason": problems,
                "note": "V3 REFUSES TO RUN. Single-session or inadequate data cannot "
                        "validate cross-session personal calibration (review BL-I)."}
    per_user = []
    for u in data["users"]:
        ss = u["sessions"]
        hist, fut = ss[:-1], ss[-1]
        # fit on the first FROZEN_N verdicts of the history sessions
        verdicts = []
        for s in hist:
            cmap = {c["candidateId"]: c for c in s.get("candidates") or []}
            for v in s.get("verdicts") or []:
                if v.get("isCatchTrial"):
                    continue
                c = cmap.get(v["candidateId"])
                if c:
                    verdicts.append((c, v["verdict"]))
        fit = verdicts[:FROZEN_N]
        cnt = defaultdict(lambda: [0, 0])
        for c, v in fit:
            k = (c["expected"], c["actual"])
            if v == "confirmed":
                cnt[k][0] += 1
            elif v == "rejected":
                cnt[k][1] += 1
        promoted = {k for k, (c, r) in cnt.items()
                    if beta_ppf_10(c, r) >= FROZEN_PROMOTE_POSTERIOR_LB}
        # baseline: T3-only on future candidates = all candidates
        fc = fut["candidates"]
        base_tp = sum(1 for c in fc if c["groundTruth"]["isTrueError"])
        base_p = base_tp / len(fc) if fc else None
        # T2 subset
        t2 = [c for c in fc if (c["expected"], c["actual"]) in promoted]
        t2_tp = sum(1 for c in t2 if c["groundTruth"]["isTrueError"])
        t2_p = t2_tp / len(t2) if t2 else None
        retained_tp = t2_tp
        per_user.append({
            "userId": u["userId"], "future_candidates": len(fc),
            "baseline_precision": base_p, "promoted_classes": sorted(map(list, promoted)),
            "t2_count": len(t2), "t2_tp": t2_tp, "t2_precision": t2_p,
            "t2_wilson_lb": wilson_lb(t2_tp, len(t2)),
            "tp_retention": (retained_tp / base_tp) if base_tp else None,
            "gain": (t2_p - base_p) if (t2_p is not None and base_p is not None) else None,
        })
    gains = [p["gain"] for p in per_user if p["gain"] is not None]
    n = len(gains)
    mean = sum(gains) / n if n else None
    sd = (sum((g - mean) ** 2 for g in gains) / (n - 1)) ** 0.5 if n > 1 else None
    se = sd / math.sqrt(n) if sd is not None else None
    # t critical for df=n-1 at 95% two-sided (small table)
    tcrit = {5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228}.get(n - 1, 2.0)
    ci_lo = (mean - tcrit * se) if (mean is not None and se is not None) else None
    t2ps = [p["t2_precision"] for p in per_user if p["t2_precision"] is not None]
    lbs = [p["t2_wilson_lb"] for p in per_user if p["t2_wilson_lb"] is not None]
    rets = [p["tp_retention"] for p in per_user if p["tp_retention"] is not None]
    verdict = {
        "executed": True,
        "users_evaluated": len(per_user),      # users meeting the data requirements
        "users_with_gain": n,                  # subset with a non-empty T2 (gain defined)
        "users_with_nonempty_t2": len(t2ps),
        "mean_gain": mean, "gain_sd": sd, "gain_ci_lower": ci_lo,
        "mean_t2_precision": (sum(t2ps) / len(t2ps)) if t2ps else None,
        "min_t2_wilson_lb": min(lbs) if lbs else None,
        "mean_tp_retention": (sum(rets) / len(rets)) if rets else None,
        "criteria": {
            "t2_absolute_floor": bool(t2ps and (sum(t2ps)/len(t2ps)) >= T2_ABS_PRECISION),
            "t2_lb_floor": bool(lbs and min(lbs) >= T2_LB_FLOOR),
            "gain_ci_lower_positive": bool(ci_lo is not None and ci_lo > 0),
            "tp_retention": bool(rets and (sum(rets)/len(rets)) >= TP_RETENTION_MIN),
            # user count must be the ADEQUATE users, not those with non-empty T2;
            # an empty T2 is a coverage failure, not a reason to shrink the denominator
            "min_users": len(per_user) >= MIN_USERS,
            "t2_coverage": len(t2ps) >= MIN_USERS,
        },
    }
    verdict["PASS"] = all(verdict["criteria"].values())
    verdict["consequence"] = ("T2 promotion MAY be enabled" if verdict["PASS"]
                              else "T2 promotion MUST STAY DISABLED; product remains T1+T3")
    return {"executed": True,
            "frozen": {"N": FROZEN_N, "promote_lb": FROZEN_PROMOTE_POSTERIOR_LB,
                        "prior_base": FROZEN_PRIOR_BASE_RATE},
            "per_user": per_user, "verdict": verdict}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["check", "evaluate", "schema"])
    ap.add_argument("data", nargs="?")
    a = ap.parse_args()
    if a.mode == "schema":
        print(json.dumps(SCHEMA, indent=2, ensure_ascii=False)); return
    if not a.data:
        raise SystemExit("data file required")
    d = json.loads(pathlib.Path(a.data).read_text())
    if a.mode == "check":
        ok, probs = check(d)
        print(json.dumps({"adequate": ok, "problems": probs}, indent=2, ensure_ascii=False))
        sys.exit(0 if ok else 1)
    r = evaluate(d)
    print(json.dumps(r, indent=2, ensure_ascii=False))
    out = pathlib.Path.cwd() / "V3_GATE_RESULT.json"
    out.write_text(json.dumps(r, indent=2, ensure_ascii=False))
    print(f"\nwrote {out}")
    sys.exit(0 if r.get("verdict", {}).get("PASS") else 1)


if __name__ == "__main__":
    main()
