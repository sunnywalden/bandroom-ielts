#!/usr/bin/env python3
"""V3-P-A: machine-panel variant of the single-user personal calibration gate.

PRE-REGISTERED in iteration-27/V3PA_PREREGISTRATION.md (do not edit to make a
result pass).  V3-P-A answers the same per-user question as V3-P ("is THIS
user's cross-session calibration reliable?") but allows the historical fit and
the future-session ground truth to be produced by calibrated machine panels
instead of a human listener.  It is NOT a product-wide claim and never
substitutes for human blind testing; the report label is fixed to
``V3-P-A(machine-panel)`` on every machine-panel result.

Relationship to the frozen gates
--------------------------------
``v3_gate.py`` and ``v3_personal_gate.py`` are FROZEN and are not imported for
their evaluation logic.  This module COPIES the V3-P ``check_user`` /
``evaluate_user`` logic (see the named disclosure below) so the panel path can
diverge without touching frozen files.  Every statistical constant and helper
is imported from ``v3_gate`` (and the V3-P session/catch constants from
``v3_personal_gate``) so no threshold can drift.  The differential test
``test_v3_personal_gate_auto.py`` is a HARD GATE: on a human-labelled document
(schema v1, ``annotatedBy: "human"``, ``verdictSource: "human"``) the copied
human path must return output that is field-by-field byte-identical to
``v3_personal_gate.evaluate_user``.  That path is the identity domain; all
machine-panel semantics live in the ``bandroom-v3-multisession-auto-v2`` path.

Machine-panel differences (pre-registered; nothing else may differ)
-------------------------------------------------------------------
* schema ``bandroom-v3-multisession-auto-v2``;
* ``groundTruth.annotatedBy`` accepts ``"calibrated-panel"`` (bare
  ``"detector"`` is still refused) and requires a sibling CG calibration
  manifest ``{panelId, modelIds, promptSha256, cgResultSha256, calibratedAt}``
  whose result file hash is verified fail-closed;
* every verdict must carry ``verdictSource`` in
  ``{human, machine-panel-A, machine-panel-B, anchors-only}``; fit must be a
  single source family and the future-truth family must differ from it;
* three-state truth mapping: ``unsure -> isTrueError=false`` is the primary,
  most conservative mapping; determinate coverage must be >= 90% of future
  candidates or the evaluation is refused; the unsure count is reported and
  the ``unsure -> true`` sensitivity variant is computed alongside;
* POOLED PASS only enables the promoted set; ``per_promoted_class`` is
  disclosure only (no per-class pass rule);
* sequential design hooks: a >= 1-new-future-session quota and a deterministic
  rolling-window Wilson-LB demotion function; fit stays frozen at FROZEN_N;
* two catch-trial tracks: the original CG-3 gate-execution rule is retained
  verbatim (>= 5 answered and >= 0.80 confirmed -> refuse); the separate
  panel-quality monitor (control misconfirmation > 0.20 -> invalid batch) is a
  distinct, documented track;
* a preregistered minimum number of determinate controls (MIN_DETERMINATE_
  CONTROLS) is required, fail-closed.

Usage:
  python3 -I v3_personal_gate_auto.py check    <data.json> <userId> [--cg-manifest PATH]
  python3 -I v3_personal_gate_auto.py evaluate <data.json> <userId> [--cg-manifest PATH]

The manifest path may also be supplied through V3PA_CG_MANIFEST.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
from collections import defaultdict

# `python3 -I` implies -P, which keeps the script's own directory off sys.path.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# Every threshold and statistical helper comes from the frozen V3-G module, so
# the variant cannot silently lower a bar.  The V3-P session/catch constants are
# imported from the frozen V3-P module for the same reason.
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
from v3_personal_gate import (  # noqa: E402
    MIN_HISTORY_SESSIONS,
    MIN_FUTURE_SESSIONS,
    CATCH_TRIAL_MIN_ANSWERED,
    CATCH_TRIAL_CONFIRM_RATE,
)

# ---- FROZEN V3-P-A PRE-REGISTRATION (iteration-27; do not edit to pass) ----
AUTO_SCHEMA = "bandroom-v3-multisession-auto-v2"
REPORT_LABEL = "V3-P-A(machine-panel)"

# Every verdict must carry one of these source labels.
VERDICT_SOURCES = ("human", "machine-panel-A", "machine-panel-B", "anchors-only")

# Determinate coverage: future candidates with a boolean truth / all future
# candidates.  Below this the evaluation is refused (fail-closed).
DETERMINATE_COVERAGE_MIN = 0.90

# Preregistered minimum number of DETERMINATE control items per evaluation
# window (unsure controls do not count).  Five matches the frozen catch-trial
# "answered" floor and prevents an evaluation carried by a couple of controls.
MIN_DETERMINATE_CONTROLS = 5

# Separate panel-quality monitor track (CG-3).  This is NOT the gate-execution
# rule: the gate-execution rule below is the original >=5 & >=0.80 refusal,
# unchanged.  The monitor invalidates the whole machine-panel batch when the
# control misconfirmation rate exceeds 0.20.
PANEL_QUALITY_MISCONFIRM_MAX = 0.20

# Rolling demotion window, in future sessions (deterministic function).
ROLLING_FUTURE_WINDOW_SESSIONS = MIN_FUTURE_SESSIONS

CG_MANIFEST_ENV = "V3PA_CG_MANIFEST"
CG_MANIFEST_DEFAULT_RESULT = "cg_result.json"
CG_MANIFEST_REQUIRED_FIELDS = (
    "panelId", "modelIds", "promptSha256", "cgResultSha256", "calibratedAt",
)
# --------------------------------------------------------------------------


# ==========================================================================
# COPIED VERBATIM FROM v3_personal_gate.py (frozen), lines 61-224.
#
# _split            v3_personal_gate.py:61-63
# check_user        v3_personal_gate.py:66-112   (renamed _check_user_human)
# evaluate_user     v3_personal_gate.py:115-224  (renamed _evaluate_user_human)
#
# The rename is the only edit; the bodies and messages are unchanged.  The
# differential test enforces byte-identical output on the human path, so any
# future drift here fails the test suite.
# ==========================================================================
def _split(sessions: list[dict]) -> tuple[list[dict], list[dict]]:
    """History = all but the last MIN_FUTURE_SESSIONS; future = the last ones."""
    return sessions[:-MIN_FUTURE_SESSIONS], sessions[-MIN_FUTURE_SESSIONS:]


def _check_user_human(data: dict, user_id: str) -> tuple[bool, list[str], dict | None]:
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


def _evaluate_user_human(data: dict, user_id: str) -> dict:
    ok, problems, user = _check_user_human(data, user_id)
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
# ==================== end copied V3-P logic ====================


# --------------------------------------------------------------------------
# V3-P-A machine-panel helpers
# --------------------------------------------------------------------------
def _truth_state(gt: dict | None) -> str:
    """Classify a ground-truth object as determinate / unsure / invalid / missing."""
    if not isinstance(gt, dict):
        return "missing"
    state = gt.get("verdictState", gt.get("state"))
    if isinstance(state, str) and state.lower() == "unsure":
        return "unsure"
    value = gt.get("isTrueError")
    if isinstance(value, bool):
        return "determinate"
    if value is None:
        return "unsure"
    if isinstance(value, str) and value.lower() == "unsure":
        return "unsure"
    return "invalid"


def _truth_primary(gt: dict) -> bool:
    """Primary preregistered mapping: unsure -> isTrueError=false."""
    return gt.get("isTrueError") if _truth_state(gt) == "determinate" else False


def _truth_sensitivity(gt: dict) -> bool:
    """Sensitivity mapping: unsure -> isTrueError=true (must never drive PASS)."""
    return gt.get("isTrueError") if _truth_state(gt) == "determinate" else True


def _source_family(source: str | None) -> str | None:
    if source == "human":
        return "human"
    if source in ("machine-panel-A", "machine-panel-B"):
        return source
    if source == "anchors-only":
        return "anchors-only"
    return None


def _future_family(gt: dict) -> str | None:
    annotated_by = gt.get("annotatedBy")
    if annotated_by == "human":
        return "human"
    if annotated_by == "calibrated-panel":
        panel = gt.get("panel") or gt.get("panelId") or gt.get("verdictSource")
        return _source_family(panel)
    return None


def _sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_manifest_path(data: dict, cg_manifest_path) -> pathlib.Path | None:
    if cg_manifest_path:
        return pathlib.Path(cg_manifest_path)
    env = os.environ.get(CG_MANIFEST_ENV)
    if env:
        return pathlib.Path(env)
    inline = data.get("cgManifestPath") or data.get("cgManifest")
    if isinstance(inline, (str, pathlib.Path)):
        return pathlib.Path(inline)
    return None


def _validate_cg_manifest(manifest_path: pathlib.Path | None,
                          data: dict) -> tuple[bool, list[str], dict]:
    """Fail-closed verification of the sealed CG calibration manifest (prereg §5)."""
    problems: list[str] = []
    info: dict = {"path": str(manifest_path) if manifest_path else None}
    if manifest_path is None:
        return False, ["CG calibration manifest is required for calibrated-panel "
                       "ground truth but no path was supplied (parameter, "
                       f"{CG_MANIFEST_ENV}, or cgManifestPath)"], info
    if not manifest_path.exists():
        return False, [f"CG calibration manifest missing: {manifest_path}"], info
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return False, [f"CG calibration manifest unreadable: {manifest_path} ({exc})"], info
    if not isinstance(manifest, dict):
        return False, ["CG calibration manifest must be a JSON object"], info

    for field in CG_MANIFEST_REQUIRED_FIELDS:
        value = manifest.get(field)
        if value in (None, "", [], {}):
            problems.append(f"CG calibration manifest missing field {field!r}")
    if problems:
        return False, problems, info

    result_name = manifest.get("cgResultFile") or CG_MANIFEST_DEFAULT_RESULT
    result_path = pathlib.Path(result_name)
    if not result_path.is_absolute():
        result_path = manifest_path.parent / result_path
    info["cgResultFile"] = str(result_path)
    if not result_path.exists():
        problems.append(f"CG calibration result file missing: {result_path}")
    else:
        actual = _sha256_file(result_path)
        info["cgResultSha256Actual"] = actual
        expected = str(manifest["cgResultSha256"]).strip().lower()
        if actual != expected:
            problems.append("CG calibration sha256 mismatch: "
                            f"cgResultFile={actual} manifest={expected}")

    info.update({"panelId": manifest.get("panelId"),
                 "modelIds": manifest.get("modelIds"),
                 "promptSha256": manifest.get("promptSha256"),
                 "calibratedAt": manifest.get("calibratedAt")})

    # Optional consistency between the document's recorded calibration context
    # and the manifest.  When the document states model ids / prompt hash /
    # panel id, they must match the sealed manifest (model or prompt changes
    # force re-calibration, prereg §5).
    recorded = data.get("calibration") or data.get("cg") or {}
    if isinstance(recorded, dict):
        for key in ("panelId", "promptSha256"):
            if key in recorded and recorded.get(key) != manifest.get(key):
                problems.append(f"document {key} does not match the CG manifest")
        if "modelIds" in recorded and list(recorded.get("modelIds") or []) != list(
                manifest.get("modelIds") or []):
            problems.append("document modelIds do not match the CG manifest")

    return (not problems), problems, info


def _check_user_auto(data: dict, user_id: str,
                     cg_manifest_path=None) -> tuple[bool, list[str], dict | None]:
    problems: list[str] = []
    if data.get("schema") != AUTO_SCHEMA:
        problems.append(f"schema must be {AUTO_SCHEMA}")
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

    # Ground truth source: human or calibrated panel.  Bare detector labels are
    # refused exactly as in V3-P.
    uses_calibrated_panel = False
    for c in future_candidates:
        gt = c.get("groundTruth") or {}
        annotated_by = gt.get("annotatedBy")
        if annotated_by not in ("human", "calibrated-panel"):
            problems.append("every future candidate needs HUMAN or calibrated-panel "
                            "ground truth; detector labels are refused")
            break
        if annotated_by == "calibrated-panel":
            uses_calibrated_panel = True
            if _future_family(gt) is None:
                problems.append("calibrated-panel ground truth must name its panel "
                                "(groundTruth.panel in machine-panel-A/B/anchors-only)")
                break

    # Three-state mapping: determinate coverage must clear the preregistered bar.
    determinate = [c for c in future_candidates
                   if _truth_state(c.get("groundTruth") or {}) == "determinate"]
    invalid = [c for c in future_candidates
               if _truth_state(c.get("groundTruth") or {}) == "invalid"]
    if invalid:
        problems.append("some future groundTruth.isTrueError values are neither "
                        "boolean nor 'unsure'")
    coverage = (len(determinate) / len(future_candidates)) if future_candidates else 0.0
    if future_candidates and coverage < DETERMINATE_COVERAGE_MIN:
        problems.append(
            f"determinate coverage {coverage:.3f} below preregistered minimum "
            f"{DETERMINATE_COVERAGE_MIN:.2f} "
            f"({len(future_candidates) - len(determinate)} unsure of "
            f"{len(future_candidates)}); refusing rather than silently degrading")

    # Every verdict must carry a valid verdictSource (prereg §2).
    all_verdicts = [v for s in sessions for v in (s.get("verdicts") or [])]
    for v in all_verdicts:
        if v.get("verdictSource") not in VERDICT_SOURCES:
            problems.append("every verdict must carry verdictSource in "
                            f"{list(VERDICT_SOURCES)}; got "
                            f"{v.get('verdictSource')!r}")
            break

    # Fit source-family separation (prereg §4).  A mixed human/panel fit
    # document is refused; distinct machine panels in the fit are also mixed.
    history_verdicts = []
    for s in history:
        cmap = {c["candidateId"]: c for c in (s.get("candidates") or [])}
        for v in s.get("verdicts") or []:
            if v.get("isCatchTrial"):
                continue
            if v.get("candidateId") in cmap:
                history_verdicts.append(v)
    fit_families = {_source_family(v.get("verdictSource")) for v in history_verdicts}
    fit_families.discard(None)
    if len(fit_families) > 1:
        problems.append("fit document mixes verdict sources "
                        f"{sorted(fit_families)}; fit must be a single source family")
    fit_family = next(iter(fit_families)) if len(fit_families) == 1 else None

    future_families = {_future_family(c.get("groundTruth") or {})
                       for c in future_candidates}
    future_families.discard(None)
    if fit_family is not None and fit_family in future_families:
        problems.append(
            f"future-truth source family {fit_family!r} is the same as the fit "
            "source family; the future annotator must differ from the fit source")

    # Sealed CG calibration evidence is required whenever a calibrated panel is
    # used (prereg §5); missing/mismatched evidence is a refusal, never a pass.
    if uses_calibrated_panel:
        manifest_path = _resolve_manifest_path(data, cg_manifest_path)
        ok, manifest_problems, _info = _validate_cg_manifest(manifest_path, data)
        if not ok:
            problems.extend(manifest_problems)

    # Catch-trial tracks (prereg §3/§6).
    controls = [v for s in sessions for v in (s.get("verdicts") or []) if v.get("isCatchTrial")]
    if not controls:
        problems.append("no catch trials recorded; the gate requires them")
    else:
        # Track 1 — CG-3 gate execution: the ORIGINAL frozen rule, unchanged.
        answered = len(controls)
        confirmed = sum(1 for v in controls if v.get("verdict") == "confirmed")
        if answered >= CATCH_TRIAL_MIN_ANSWERED and confirmed / answered >= CATCH_TRIAL_CONFIRM_RATE:
            problems.append(f"constant confirmer: {confirmed}/{answered} controls confirmed; "
                            f"verdicts are uninformative")

        # Track 2 — panel-quality monitor (separate; <= 0.20 misconfirmation).
        determinate_controls = [v for v in controls
                                if v.get("verdict") in ("confirmed", "rejected")]
        if len(determinate_controls) < MIN_DETERMINATE_CONTROLS:
            problems.append(
                f"panel-quality monitor: only {len(determinate_controls)} determinate "
                f"controls; preregistered minimum is {MIN_DETERMINATE_CONTROLS}")
        else:
            misconfirmed = sum(1 for v in determinate_controls
                               if v.get("verdict") == "confirmed")
            rate = misconfirmed / len(determinate_controls)
            if rate > PANEL_QUALITY_MISCONFIRM_MAX:
                problems.append(
                    f"panel-quality monitor: control misconfirmation rate {rate:.3f} "
                    f"exceeds {PANEL_QUALITY_MISCONFIRM_MAX:.2f}; batch is invalid and "
                    "T2 stays frozen (separate from the gate-execution track)")

    return (not problems), problems, user


def _pooled_metrics(all_future: list[dict], promoted: set[tuple],
                    truth_fn) -> dict:
    base_tp = sum(1 for c in all_future if truth_fn(c["groundTruth"]))
    t2_all = [c for c in all_future if (c["expected"], c["actual"]) in promoted]
    t2_tp = sum(1 for c in t2_all if truth_fn(c["groundTruth"]))
    t2_precision = (t2_tp / len(t2_all)) if t2_all else None
    lb = wilson_lb(t2_tp, len(t2_all))
    retention = (t2_tp / base_tp) if base_tp else None
    return {
        "baseline_precision": (base_tp / len(all_future)) if all_future else None,
        "t2_count": len(t2_all),
        "t2_tp": t2_tp,
        "t2_precision": t2_precision,
        "t2_wilson_lb": lb,
        "tp_retention": retention,
    }


def _criteria_for(metrics: dict, with_t2_count: int, consistent: int) -> dict:
    return {
        "t2_absolute": bool(metrics["t2_precision"] is not None
                            and metrics["t2_precision"] >= T2_ABS_PRECISION),
        "t2_lb": bool(metrics["t2_wilson_lb"] is not None
                      and metrics["t2_wilson_lb"] >= T2_LB_FLOOR),
        "tp_retention": bool(metrics["tp_retention"] is not None
                             and metrics["tp_retention"] >= TP_RETENTION_MIN),
        "multi_session_evidence": with_t2_count >= MIN_FUTURE_SESSIONS,
        "session_consistency": bool(with_t2_count) and consistent * 2 >= with_t2_count,
    }


def _evaluate_user_auto(data: dict, user_id: str,
                        cg_manifest_path=None) -> dict:
    ok, problems, user = _check_user_auto(data, user_id, cg_manifest_path)
    if not ok:
        return {"executed": False, "gate": REPORT_LABEL, "userId": user_id,
                "refusal_reason": problems,
                "note": "V3-P-A REFUSES TO RUN. Machine-panel evidence that fails "
                        "data adequacy, source separation, coverage, control, or CG "
                        "manifest verification cannot support a calibration claim."}

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

    all_future = [c for s in future for c in (s.get("candidates") or [])]
    primary = _pooled_metrics(all_future, promoted, _truth_primary)
    sensitivity = _pooled_metrics(all_future, promoted, _truth_sensitivity)

    # Per-session disclosure uses the primary (unsure -> false) mapping.
    per_session = []
    for s in future:
        fc = s.get("candidates") or []
        if not fc:
            continue
        base_tp = sum(1 for c in fc if _truth_primary(c["groundTruth"]))
        t2 = [c for c in fc if (c["expected"], c["actual"]) in promoted]
        t2_tp = sum(1 for c in t2 if _truth_primary(c["groundTruth"]))
        unsure_count = sum(1 for c in fc
                           if _truth_state(c["groundTruth"]) != "determinate")
        per_session.append({
            "sessionId": s.get("sessionId"),
            "future_candidates": len(fc),
            "unsure_truth_count": unsure_count,
            "baseline_precision": base_tp / len(fc),
            "t2_count": len(t2),
            "t2_tp": t2_tp,
            "t2_precision": (t2_tp / len(t2)) if t2 else None,
            "consistent": bool(t2) and (t2_tp / len(t2)) >= (base_tp / len(fc)),
        })

    with_t2 = [s for s in per_session if s["t2_count"] > 0]
    consistent = sum(1 for s in with_t2 if s["consistent"])
    # Session consistency under the sensitivity mapping is recomputed rather
    # than borrowed from the primary mapping, so both variants are complete.
    sensitivity_consistent = 0
    for s in future:
        fc = s.get("candidates") or []
        if not fc:
            continue
        base_tp_s = sum(1 for c in fc if _truth_sensitivity(c["groundTruth"]))
        t2_s = [c for c in fc if (c["expected"], c["actual"]) in promoted]
        if not t2_s:
            continue
        t2_tp_s = sum(1 for c in t2_s if _truth_sensitivity(c["groundTruth"]))
        if (t2_tp_s / len(t2_s)) >= (base_tp_s / len(fc)):
            sensitivity_consistent += 1
    criteria = _criteria_for(primary, len(with_t2), consistent)
    sensitivity_criteria = _criteria_for(sensitivity, len(with_t2),
                                         sensitivity_consistent)
    passed = all(criteria.values())
    sensitivity_passed = all(sensitivity_criteria.values())

    per_class = []
    for key in sorted(promoted):
        occ = [c for c in all_future if (c["expected"], c["actual"]) == key]
        tp = sum(1 for c in occ if _truth_primary(c["groundTruth"]))
        per_class.append({"expected": key[0], "actual": key[1],
                          "future_occurrences": len(occ), "true_errors": tp,
                          "precision": (tp / len(occ)) if occ else None,
                          "wilson_lb": wilson_lb(tp, len(occ))})

    determinate_count = sum(1 for c in all_future
                            if _truth_state(c.get("groundTruth") or {}) == "determinate")
    unsure_count = len(all_future) - determinate_count
    coverage = (determinate_count / len(all_future)) if all_future else 0.0

    # Source disclosure.
    history_verdicts = []
    for s in history:
        cmap = {c["candidateId"]: c for c in (s.get("candidates") or [])}
        history_verdicts.extend(v for v in (s.get("verdicts") or [])
                                if not v.get("isCatchTrial")
                                and v.get("candidateId") in cmap)
    fit_families = {_source_family(v.get("verdictSource"))
                    for v in history_verdicts}
    fit_families.discard(None)
    future_families = {_future_family(c.get("groundTruth") or {})
                       for c in all_future}
    future_families.discard(None)
    manifest_path = _resolve_manifest_path(data, cg_manifest_path)
    manifest_used = any((c.get("groundTruth") or {}).get("annotatedBy")
                        == "calibrated-panel" for c in all_future)
    manifest_info = {}
    if manifest_used:
        _ok, _probs, manifest_info = _validate_cg_manifest(manifest_path, data)

    # Catch-trial disclosure: two tracks, documented separately.
    controls = [v for s in sessions for v in (s.get("verdicts") or [])
                if v.get("isCatchTrial")]
    determinate_controls = [v for v in controls
                            if v.get("verdict") in ("confirmed", "rejected")]
    confirmed = sum(1 for v in controls if v.get("verdict") == "confirmed")
    gate_rate = (confirmed / len(controls)) if controls else None
    monitor_rate = (confirmed / len(determinate_controls)) if determinate_controls else None
    catch_tracks = {
        "gate_execution": {
            "rule": f">= {CATCH_TRIAL_MIN_ANSWERED} answered and "
                    f">= {CATCH_TRIAL_CONFIRM_RATE:.2f} confirmed -> refuse (frozen)",
            "answered": len(controls),
            "confirmed": confirmed,
            "confirmation_rate": gate_rate,
        },
        "panel_quality_monitor": {
            "rule": f"control misconfirmation > {PANEL_QUALITY_MISCONFIRM_MAX:.2f} "
                    "-> batch invalid, T2 frozen (separate track)",
            "determinate_controls": len(determinate_controls),
            "misconfirmation_rate": monitor_rate,
            "monitor_triggered": bool(monitor_rate is not None
                                      and monitor_rate > PANEL_QUALITY_MISCONFIRM_MAX),
        },
    }

    decision_note = (
        "Machine-panel judgments are NOT human blind testing. Residual anchor "
        "correlation with the detector is disclosed and cannot be removed; if "
        "panel separation fails, the claim degrades to panel-consistency and no "
        "unlock occurs."
    )
    return {
        "executed": True,
        "gate": REPORT_LABEL,
        "userId": user_id,
        "claim_scope": "THIS USER ONLY — not a product-wide claim; new users still "
                       "require V3-G. Machine-panel verdicts are not human blind "
                       "testing.",
        "variant": {
            "schema": AUTO_SCHEMA,
            "panel_label": REPORT_LABEL,
            "truth_mapping_primary": "unsure -> isTrueError=false (most conservative)",
            "truth_mapping_sensitivity": "unsure -> isTrueError=true",
            "determinate_coverage_min": DETERMINATE_COVERAGE_MIN,
            "min_determinate_controls": MIN_DETERMINATE_CONTROLS,
            "panel_quality_misconfirm_max": PANEL_QUALITY_MISCONFIRM_MAX,
            "decision_unlock": "pooled only; per-class output is disclosure only",
            "identity_path": "frozen v1 human documents are evaluated by the copied "
                             "V3-P logic and must be byte-identical (differential test)",
        },
        "frozen": {"N": FROZEN_N, "promote_lb": FROZEN_PROMOTE_POSTERIOR_LB,
                   "prior_base": FROZEN_PRIOR_BASE_RATE,
                   "t2_abs": T2_ABS_PRECISION, "t2_lb": T2_LB_FLOOR,
                   "tp_retention": TP_RETENTION_MIN,
                   "min_history_sessions": MIN_HISTORY_SESSIONS,
                   "min_future_sessions": MIN_FUTURE_SESSIONS,
                   "catch_min_answered": CATCH_TRIAL_MIN_ANSWERED,
                   "catch_confirm_rate": CATCH_TRIAL_CONFIRM_RATE},
        "sources": {
            "fit_family": next(iter(fit_families)) if len(fit_families) == 1 else None,
            "future_families": sorted(future_families),
            "separated": bool(fit_families and future_families
                              and not (fit_families & future_families)),
            "cg_manifest": manifest_info,
        },
        "history_sessions": len(history),
        "future_sessions": len(future),
        "future_session_ids": [s.get("sessionId") for s in future],
        "fit_verdicts_used": len(fit),
        "fit_frozen_at": FROZEN_N,
        "promoted_classes": sorted(map(list, promoted)),
        "future_candidates": len(all_future),
        "unsure_truth_count": unsure_count,
        "excluded_unsure_count": unsure_count,
        "determinate_coverage": coverage,
        "baseline_precision": primary["baseline_precision"],
        "t2_count": primary["t2_count"],
        "t2_tp": primary["t2_tp"],
        "t2_precision": primary["t2_precision"],
        "t2_wilson_lb": primary["t2_wilson_lb"],
        "tp_retention": primary["tp_retention"],
        "per_future_session": per_session,
        "per_promoted_class": per_class,
        "catch_trial_tracks": catch_tracks,
        "sensitivity": {
            "primary": {"mapping": "unsure->false", **primary, "criteria": criteria,
                        "PASS": passed},
            "unsure_to_true": {"mapping": "unsure->true", **sensitivity,
                               "criteria": sensitivity_criteria,
                               "PASS": sensitivity_passed},
            "decision_flips_under_sensitivity": bool(passed != sensitivity_passed),
        },
        "criteria": criteria,
        "PASS": passed,
        "unlock": {
            "scope": "pooled_only",
            "per_class_unlock": False,
            "promoted_classes": (sorted(map(list, promoted)) if passed else []),
            "disclosure_only": "per_promoted_class has no independent pass rule",
        },
        "sequential_design": {
            "evaluation_quota": ">= 1 new future session since the last evaluation",
            "fit_frozen_at": FROZEN_N,
            "demotion_rule": (f"rolling {ROLLING_FUTURE_WINDOW_SESSIONS}-future-session "
                              f"Wilson LB < {T2_LB_FLOOR:.2f} -> demote"),
        },
        "decision_note": decision_note,
        "consequence": (
            "T2 MAY be enabled FOR THIS USER ONLY as the POOLED promoted set, with "
            "personal hedging retained; re-validate after >= 1 new future session and "
            "demote deterministically if the rolling Wilson LB falls below the floor."
            if passed else
            "T2 MUST STAY DISABLED for this user; product remains T1+T3. "
            "No constant may be adjusted to make this pass."),
    }


# --------------------------------------------------------------------------
# Public dispatch: human v1 documents stay on the frozen identity path.
# --------------------------------------------------------------------------
def check_user(data: dict, user_id: str,
               cg_manifest_path=None) -> tuple[bool, list[str], dict | None]:
    """Validate one user.

    A frozen-schema (v1) document is evaluated by the verbatim copied V3-P
    logic so the differential test sees byte-identical behaviour.  The
    machine-panel variant is selected only by the auto-v2 schema.
    """
    if data.get("schema") == SCHEMA["schema"]:
        return _check_user_human(data, user_id)
    return _check_user_auto(data, user_id, cg_manifest_path)


def evaluate_user(data: dict, user_id: str,
                  cg_manifest_path=None) -> dict:
    """Evaluate one user.  See check_user for the schema dispatch."""
    if data.get("schema") == SCHEMA["schema"]:
        return _evaluate_user_human(data, user_id)
    return _evaluate_user_auto(data, user_id, cg_manifest_path)


# --------------------------------------------------------------------------
# Sequential-design hooks (prereg §6)
# --------------------------------------------------------------------------
def check_sequential_quota(previous_evaluation: dict | None,
                           data: dict, user_id: str) -> dict:
    """Require >= 1 new future session since the previous evaluation.

    Repeated analysis of the same recordings (re-analysis) must never satisfy
    the quota: the window is compared by true session id, not by candidate
    count or wall-clock re-runs.  A previous evaluation that does not record
    its future session ids is refused (fail-closed), not assumed stale.
    """
    user = next((u for u in (data.get("users") or []) if u.get("userId") == user_id), None)
    if user is None:
        return {"allowed": False, "reason": f"user {user_id} not present"}
    sessions = user.get("sessions") or []
    if len(sessions) < MIN_HISTORY_SESSIONS + MIN_FUTURE_SESSIONS:
        return {"allowed": False, "reason": "not enough sessions to form a window"}
    current = [s.get("sessionId") for s in sessions[-MIN_FUTURE_SESSIONS:]]
    if previous_evaluation is None:
        return {"allowed": True, "reason": "first evaluation", "new_sessions": current,
                "current_future_session_ids": current}
    prior = previous_evaluation.get("future_session_ids")
    if not isinstance(prior, list) or not prior:
        return {"allowed": False,
                "reason": "previous evaluation recorded no future_session_ids; "
                          "cannot prove new data (fail-closed)",
                "current_future_session_ids": current}
    new = [sid for sid in current if sid not in set(prior)]
    return {
        "allowed": bool(new),
        "reason": ("quota satisfied" if new else
                   "no new future session since the last evaluation; "
                   "re-analysis of the same recording cannot create a session"),
        "new_sessions": new,
        "current_future_session_ids": current,
        "previous_future_session_ids": prior,
    }


def demote_if_degraded(data: dict, user_id: str, promoted_classes,
                       window_sessions: int = ROLLING_FUTURE_WINDOW_SESSIONS) -> dict:
    """Deterministic demotion on the rolling future window.

    The promoted set is demoted when the Wilson 95% lower bound of the T2
    subset over the most recent ``window_sessions`` future sessions falls below
    the frozen T2_LB_FLOOR.  The primary (unsure -> false) mapping is used.
    Same inputs always produce the same decision; there is no discretionary
    "conflict" judge.
    """
    promoted = {tuple(k) if isinstance(k, (list, tuple)) else k
                for k in (promoted_classes or [])}
    user = next((u for u in (data.get("users") or []) if u.get("userId") == user_id), None)
    if user is None:
        return {"demoted": False, "reason": f"user {user_id} not present",
                "t2_count": 0, "t2_tp": 0, "wilson_lb": None}
    sessions = user.get("sessions") or []
    window = sessions[-max(1, int(window_sessions)):]
    candidates = [c for s in window for c in (s.get("candidates") or [])]
    t2 = [c for c in candidates if (c["expected"], c["actual"]) in promoted]
    tp = sum(1 for c in t2 if _truth_primary(c.get("groundTruth") or {}))
    lb = wilson_lb(tp, len(t2))
    demoted = bool(lb is not None and lb < T2_LB_FLOOR)
    return {
        "demoted": demoted,
        "reason": ("rolling window Wilson LB below floor" if demoted else
                   "no demotion evidence in the rolling window"),
        "window_sessions": [s.get("sessionId") for s in window],
        "t2_count": len(t2),
        "t2_tp": tp,
        "wilson_lb": lb,
        "floor": T2_LB_FLOOR,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "evaluate"])
    parser.add_argument("data")
    parser.add_argument("user_id")
    parser.add_argument("--cg-manifest", default=None,
                        help="path to the sealed CG calibration manifest "
                             f"(default: ${CG_MANIFEST_ENV} or cgManifestPath)")
    args = parser.parse_args()
    document = json.loads(pathlib.Path(args.data).read_text())
    if args.mode == "check":
        ok, problems, _ = check_user(document, args.user_id, args.cg_manifest)
        print(json.dumps({"adequate": ok, "problems": problems},
                         ensure_ascii=False, indent=2))
        return 0 if ok else 1
    result = evaluate_user(document, args.user_id, args.cg_manifest)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("PASS") else 1


if __name__ == "__main__":
    sys.exit(main())