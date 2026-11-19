#!/usr/bin/env python3
"""Tests for V3-P-A, the machine-panel variant of the personal gate.

The centrepiece is the HARD differential gate: on a human-labelled document
(schema v1, ``annotatedBy: "human"``, ``verdictSource: "human"``) the copied
V3-P logic inside ``v3_personal_gate_auto.py`` must return output that is
field-by-field byte-identical to the frozen ``v3_personal_gate.evaluate_user``.
Function-object identity assertions cover every imported constant/helper.
Further tests cover mixed-source rejection, the unsure->false mapping and its
sensitivity variant, coverage refusal, CG-manifest fail-closed verification,
pooled-only unlock, deterministic demotion, and the sequential/re-analysis
quota.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile

B = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(B))

import v3_gate as v3g  # noqa: E402
import v3_personal_gate as v3p  # noqa: E402

spec = importlib.util.spec_from_file_location("v3pa", B / "v3_personal_gate_auto.py")
v3pa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v3pa)

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))


# --------------------------------------------------------------------------
# Fixtures.  Everything is synthetic and written to temp dirs; no personal
# paths, ids, or keys appear anywhere.
# --------------------------------------------------------------------------
def candidate(cid, expected="DH", actual="D", true_error=True, at=1000,
              annotated_by="human", panel=None):
    gt = {"isTrueError": true_error, "annotatedBy": annotated_by,
          "intervalStartMs": at, "intervalEndMs": at + 120}
    if panel is not None:
        gt["panel"] = panel
    return {"candidateId": cid, "word": "they", "expected": expected, "actual": actual,
            "atMs": at, "detectorConfidence": 0.9, "groundTruth": gt}


def session(sid, day, candidates, verdicts=None, controls=0, source="human"):
    verdicts = list(verdicts or [])
    for i in range(controls):
        verdicts.append({"candidateId": f"{sid}_ctl{i}", "verdict": "rejected",
                         "isCatchTrial": True, "verdictSource": source})
    return {"sessionId": sid, "recordedAt": f"2026-11-{day:02d}T00:00:00Z",
            "audioSha256": "a" * 64, "speechSeconds": 60.0,
            "candidates": candidates, "verdicts": verdicts}


def history_session(sid, day, n=4, source="human"):
    cands = [candidate(f"{sid}_c{i}", at=1000 * i) for i in range(n)]
    verdicts = [{"candidateId": c["candidateId"], "verdict": "confirmed",
                 "isCatchTrial": False, "verdictSource": source} for c in cands]
    return session(sid, day, cands, verdicts, controls=2, source=source)


def future_session(sid, day, n_good=10, n_bad=2, source="human",
                   annotated_by="human", panel=None):
    cands = [candidate(f"{sid}_g{i}", at=1000 * i,
                       annotated_by=annotated_by, panel=panel) for i in range(n_good)]
    cands += [candidate(f"{sid}_b{i}", expected="TH", actual="S",
                        true_error=False, at=20000 + 1000 * i,
                        annotated_by=annotated_by, panel=panel) for i in range(n_bad)]
    # A human listener answers nothing in the future sessions; controls are
    # still recorded there.
    return session(sid, day, cands, controls=2, source=source)


def human_doc(user="u1"):
    """Frozen-schema human document: the differential identity domain."""
    return {"schema": v3g.SCHEMA["schema"], "users": [{"userId": user, "sessions": [
        history_session("h0", 10), history_session("h1", 11),
        future_session("f0", 12), future_session("f1", 13)]}]}


def auto_doc(user="u1"):
    """Machine-panel document: panel-A fit, panel-B future truth."""
    sessions = [
        history_session("h0", 10, source="machine-panel-A"),
        history_session("h1", 11, source="machine-panel-A"),
        future_session("f0", 12, n_good=15, n_bad=5, source="machine-panel-A",
                       annotated_by="calibrated-panel", panel="machine-panel-B"),
        future_session("f1", 13, n_good=15, n_bad=5, source="machine-panel-A",
                       annotated_by="calibrated-panel", panel="machine-panel-B"),
    ]
    return {
        "schema": v3pa.AUTO_SCHEMA,
        "calibration": {"panelId": "panel-fixture-1",
                        "modelIds": ["model-a", "model-b"],
                        "promptSha256": "p" * 64},
        "users": [{"userId": user, "sessions": sessions}],
    }


def write_manifest(td, *, sha_override=None, result_bytes=b'{"cg": "ok"}\n',
                   panel_id="panel-fixture-1"):
    directory = pathlib.Path(td)
    result = directory / "cg_result.json"
    result.write_bytes(result_bytes)
    digest = hashlib.sha256(result_bytes).hexdigest()
    manifest = {
        "panelId": panel_id,
        "modelIds": ["model-a", "model-b"],
        "promptSha256": "p" * 64,
        "cgResultSha256": sha_override if sha_override is not None else digest,
        "calibratedAt": "2026-11-19T00:00:00Z",
    }
    path = directory / "cg_manifest.json"
    path.write_text(json.dumps(manifest))
    return path


def evaluate_auto(document, manifest=None):
    return v3pa.evaluate_user(document, "u1", cg_manifest_path=manifest)


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------
def test_function_identity():
    check("T2 absolute floor is the same object/value as V3-G",
          v3pa.T2_ABS_PRECISION == v3g.T2_ABS_PRECISION)
    check("T2 Wilson floor is the same object/value as V3-G",
          v3pa.T2_LB_FLOOR == v3g.T2_LB_FLOOR)
    check("TP retention is the same object/value as V3-G",
          v3pa.TP_RETENTION_MIN == v3g.TP_RETENTION_MIN)
    check("MIN_FUTURE_CANDIDATES is the same object/value as V3-G",
          v3pa.MIN_FUTURE_CANDIDATES == v3g.MIN_FUTURE_CANDIDATES)
    check("fit N is the same object/value as V3-G", v3pa.FROZEN_N == v3g.FROZEN_N)
    check("promotion posterior is the same object/value as V3-G",
          v3pa.FROZEN_PROMOTE_POSTERIOR_LB == v3g.FROZEN_PROMOTE_POSTERIOR_LB)
    check("prior base rate is the same object/value as V3-G",
          v3pa.FROZEN_PRIOR_BASE_RATE == v3g.FROZEN_PRIOR_BASE_RATE)
    check("SCHEMA is the very same dict object as V3-G", v3pa.SCHEMA is v3g.SCHEMA)
    check("wilson helper is the same function object", v3pa.wilson_lb is v3g.wilson_lb)
    check("beta helper is the same function object", v3pa.beta_ppf_10 is v3g.beta_ppf_10)
    check("min history sessions identical to V3-P",
          v3pa.MIN_HISTORY_SESSIONS == v3p.MIN_HISTORY_SESSIONS)
    check("min future sessions identical to V3-P",
          v3pa.MIN_FUTURE_SESSIONS == v3p.MIN_FUTURE_SESSIONS)
    check("catch-trial answered floor identical to V3-P",
          v3pa.CATCH_TRIAL_MIN_ANSWERED == v3p.CATCH_TRIAL_MIN_ANSWERED)
    check("catch-trial confirm rate identical to V3-P",
          v3pa.CATCH_TRIAL_CONFIRM_RATE == v3p.CATCH_TRIAL_CONFIRM_RATE)


def _j(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def assert_identical(label, document):
    frozen = v3p.evaluate_user(document, "u1")
    auto = v3pa.evaluate_user(document, "u1")
    check(f"{label}: dict equality", frozen == auto,
          _j({"frozen": frozen, "auto": auto}))
    check(f"{label}: field-by-field byte-identical JSON", _j(frozen) == _j(auto))
    if frozen == auto:
        check(f"{label}: no extra variant fields on the human path",
              set(frozen) == set(auto))
        if "gate" in frozen:
            check(f"{label}: gate label stays V3-P on the identity path",
                  auto.get("gate") == "V3-P")
        else:
            check(f"{label}: refusal carries no variant gate label",
                  "gate" not in auto)


def test_differential_hard_gate():
    # Same human-labelled document to both gates: byte-identical output.
    assert_identical("adequate human document", human_doc())

    # Drift coverage across refusal and failure shapes.
    single = {"schema": v3g.SCHEMA["schema"], "users": [{"userId": "u1", "sessions": [
        history_session("h0", 10)]}]}
    assert_identical("single-session refusal", single)

    detector = human_doc()
    detector["users"][0]["sessions"][-1]["candidates"][0]["groundTruth"]["annotatedBy"] = "detector"
    assert_identical("detector-truth refusal", detector)

    confirmer = human_doc()
    for s in confirmer["users"][0]["sessions"]:
        for v in s["verdicts"]:
            if v.get("isCatchTrial"):
                v["verdict"] = "confirmed"
    assert_identical("constant-confirmer refusal", confirmer)

    weak = human_doc()
    for s in weak["users"][0]["sessions"][-2:]:
        for c in s["candidates"]:
            if c["expected"] == "DH":
                c["groundTruth"]["isTrueError"] = False
    assert_identical("weak future failure", weak)

    single_driver = {"schema": v3g.SCHEMA["schema"], "users": [{"userId": "u1", "sessions": [
        history_session("h0", 10), history_session("h1", 11),
        future_session("f0", 12, n_good=20, n_bad=2),
        future_session("f1", 13, n_good=0, n_bad=10)]}]}
    assert_identical("single-session driver failure", single_driver)


def test_auto_accepts_calibrated_panel():
    document = auto_doc()
    with tempfile.TemporaryDirectory() as td:
        manifest = write_manifest(td)
        ok, problems, _ = v3pa.check_user(document, "u1", cg_manifest_path=manifest)
        check("auto-v2 calibrated-panel document is adequate", ok, json.dumps(problems))
        result = evaluate_auto(document, manifest)
        check("auto evaluation executes with a valid manifest",
              result.get("executed") is True, json.dumps(result.get("refusal_reason")))
        if result.get("executed"):
            check("report label is fixed V3-P-A(machine-panel)",
                  result.get("gate") == "V3-P-A(machine-panel)")
            check("strong machine-panel corpus passes", result.get("PASS") is True,
                  json.dumps(result.get("criteria")))
            check("source families are disclosed",
                  result["sources"]["fit_family"] == "machine-panel-A"
                  and "machine-panel-B" in result["sources"]["future_families"])
            check("fit is frozen at FROZEN_N", result["fit_frozen_at"] == v3g.FROZEN_N)


def test_rejections():
    # Bare detector labels are still refused.
    detector = auto_doc()
    detector["users"][0]["sessions"][-1]["candidates"][0]["groundTruth"]["annotatedBy"] = "detector"
    ok, problems, _ = v3pa.check_user(detector, "u1")
    check("auto refuses bare detector truth",
          not ok and any("detector" in p for p in problems), json.dumps(problems))

    # Every verdict must carry a valid verdictSource.
    missing_source = auto_doc()
    del missing_source["users"][0]["sessions"][0]["verdicts"][0]["verdictSource"]
    ok, problems, _ = v3pa.check_user(missing_source, "u1")
    check("auto refuses a verdict without verdictSource",
          not ok and any("verdictSource" in p for p in problems), json.dumps(problems))

    # Mixed human/panel fit document.
    mixed = auto_doc()
    mixed["users"][0]["sessions"][1]["verdicts"][0]["verdictSource"] = "human"
    ok, problems, _ = v3pa.check_user(mixed, "u1")
    check("auto refuses a mixed human/panel fit document",
          not ok and any("mixes verdict sources" in p for p in problems),
          json.dumps(problems))

    # Future truth source family must differ from the fit source family.
    same_family = auto_doc()
    for s in same_family["users"][0]["sessions"][-2:]:
        for c in s["candidates"]:
            c["groundTruth"]["panel"] = "machine-panel-A"
    ok, problems, _ = v3pa.check_user(same_family, "u1")
    check("auto refuses fit/future source-family overlap",
          not ok and any("same as the fit source family" in p for p in problems),
          json.dumps(problems))

    # Calibrated-panel truth must name its panel.
    unnamed = auto_doc()
    for s in unnamed["users"][0]["sessions"][-2:]:
        for c in s["candidates"]:
            c["groundTruth"].pop("panel", None)
    ok, problems, _ = v3pa.check_user(unnamed, "u1")
    check("auto refuses calibrated-panel truth without a panel identity",
          not ok and any("must name its panel" in p for p in problems),
          json.dumps(problems))


def test_three_state_mapping():
    with tempfile.TemporaryDirectory() as td:
        manifest = write_manifest(td)

        # Small unsure fraction (3/40 = 7.5%) keeps coverage >= 90%.
        document = auto_doc()
        unsure_labels = 0
        for s in document["users"][0]["sessions"][-2:]:
            for c in s["candidates"][:2]:
                if unsure_labels < 3 and c["expected"] == "DH":
                    c["groundTruth"]["isTrueError"] = "unsure"
                    unsure_labels += 1
        result = evaluate_auto(document, manifest)
        check("small unsure fraction still evaluates", result.get("executed") is True,
              json.dumps(result.get("refusal_reason")))
        if result.get("executed"):
            check("excluded unsure count is reported",
                  result["excluded_unsure_count"] == 3, result.get("excluded_unsure_count"))
            check("determinate coverage is reported",
                  abs(result["determinate_coverage"] - 37 / 40) < 1e-12)
            primary = result["sensitivity"]["primary"]
            alt = result["sensitivity"]["unsure_to_true"]
            check("primary maps unsure -> false (fewer true errors)",
                  primary["t2_tp"] == alt["t2_tp"] - 3,
                  _j({"primary": primary["t2_tp"], "alt": alt["t2_tp"]}))
            check("sensitivity block carries both mappings",
                  {"unsure->false", "unsure->true"}
                  == {primary["mapping"], alt["mapping"]})

        # Coverage below 90% is a fail-closed refusal.
        below = auto_doc()
        marked = 0
        for s in below["users"][0]["sessions"][-2:]:
            for c in s["candidates"]:
                if marked < 5 and c["expected"] == "DH":
                    c["groundTruth"]["isTrueError"] = "unsure"
                    marked += 1
        result = evaluate_auto(below, manifest)
        check("coverage < 90% refuses evaluation",
              result.get("executed") is False
              and any("determinate coverage" in p for p in result["refusal_reason"]),
              _j(result))


def test_cg_manifest_fail_closed():
    document = auto_doc()

    result = evaluate_auto(document, None)
    check("missing manifest path refuses calibrated-panel evaluation",
          result.get("executed") is False
          and any("CG calibration manifest" in p for p in result["refusal_reason"]),
          _j(result))

    with tempfile.TemporaryDirectory() as td:
        missing = pathlib.Path(td) / "does_not_exist.json"
        result = evaluate_auto(document, missing)
        check("nonexistent manifest refuses evaluation",
              result.get("executed") is False
              and any("manifest missing" in p for p in result["refusal_reason"]),
              _j(result))

        bad = write_manifest(td, sha_override="0" * 64)
        result = evaluate_auto(document, bad)
        check("sha256 mismatch refuses evaluation",
              result.get("executed") is False
              and any("sha256 mismatch" in p for p in result["refusal_reason"]),
              _j(result))

        # A missing required manifest field also refuses.
        good = write_manifest(td)
        payload = json.loads(good.read_text())
        payload.pop("calibratedAt")
        good.write_text(json.dumps(payload))
        result = evaluate_auto(document, good)
        check("missing manifest field refuses evaluation",
              result.get("executed") is False
              and any("calibratedAt" in p for p in result["refusal_reason"]),
              _j(result))


def test_pooled_only_unlock():
    with tempfile.TemporaryDirectory() as td:
        manifest = write_manifest(td)
        result = evaluate_auto(auto_doc(), manifest)
        check("pooled unlock test has a passing result", result.get("PASS") is True)
        if result.get("PASS"):
            unlock = result["unlock"]
            check("unlock scope is pooled_only", unlock["scope"] == "pooled_only")
            check("per-class unlock is disabled", unlock["per_class_unlock"] is False)
            check("pooled PASS enables the promoted set",
                  len(unlock["promoted_classes"]) >= 1)
            check("per_promoted_class is disclosure only",
                  all("pass" not in row and "PASS" not in row
                      for row in result["per_promoted_class"]))


def test_demotion_deterministic():
    promoted = [["DH", "D"]]
    good = auto_doc()
    first = v3pa.demote_if_degraded(good, "u1", promoted)
    second = v3pa.demote_if_degraded(good, "u1", promoted)
    check("demotion is deterministic across identical inputs", first == second)
    check("healthy rolling window is not demoted", first["demoted"] is False,
          _j(first))
    check("demotion floor is the frozen 0.70", first["floor"] == v3g.T2_LB_FLOOR)

    degraded = auto_doc()
    for c in degraded["users"][0]["sessions"][-1]["candidates"]:
        if c["expected"] == "DH":
            c["groundTruth"]["isTrueError"] = False
    dec = v3pa.demote_if_degraded(degraded, "u1", promoted)
    check("rolling window below the floor demotes", dec["demoted"] is True, _j(dec))
    check("demotion decision is a pure function of the statistic",
          v3pa.demote_if_degraded(degraded, "u1", promoted) == dec)


def test_sequential_quota_and_reanalysis():
    document = auto_doc()
    first = v3pa.check_sequential_quota(None, document, "u1")
    check("first evaluation satisfies the quota", first["allowed"] is True)

    previous = {"future_session_ids": ["f0", "f1"]}
    repeat = v3pa.check_sequential_quota(previous, document, "u1")
    check("re-analysis of the same sessions does not satisfy the quota",
          repeat["allowed"] is False and "re-analysis" in repeat["reason"],
          _j(repeat))

    extended = auto_doc()
    extended["users"][0]["sessions"].append(
        future_session("f2", 14, n_good=15, n_bad=5, source="machine-panel-A",
                       annotated_by="calibrated-panel", panel="machine-panel-B"))
    fresh = v3pa.check_sequential_quota(previous, extended, "u1")
    check("one new future session satisfies the quota",
          fresh["allowed"] is True and fresh["new_sessions"] == ["f2"], _j(fresh))

    no_ids = v3pa.check_sequential_quota({"gate": "V3-P-A(machine-panel)"}, document, "u1")
    check("previous evaluation without session ids is refused (fail-closed)",
          no_ids["allowed"] is False, _j(no_ids))


def test_catch_trial_tracks():
    # Monitor track: >0.20 control misconfirmation invalidates the batch even
    # though the original >=0.80 gate-execution rule would not fire.
    document = auto_doc()
    controls = [v for s in document["users"][0]["sessions"] for v in s["verdicts"]
                if v.get("isCatchTrial")]
    for v in controls[:4]:
        v["verdict"] = "confirmed"      # 4/8 = 0.50 > 0.20
    ok, problems, _ = v3pa.check_user(document, "u1")
    check("panel-quality monitor refuses >20% misconfirmation",
          not ok and any("panel-quality monitor" in p for p in problems),
          json.dumps(problems))

    # Gate-execution track: the original constant-confirmer rule still fires.
    confirmer = auto_doc()
    for s in confirmer["users"][0]["sessions"]:
        for v in s["verdicts"]:
            if v.get("isCatchTrial"):
                v["verdict"] = "confirmed"
    ok, problems, _ = v3pa.check_user(confirmer, "u1")
    check("gate-execution constant-confirmer rule is retained",
          not ok and any("constant confirmer" in p for p in problems),
          json.dumps(problems))

    # Not enough determinate controls is a refusal.
    thin = auto_doc()
    for s in thin["users"][0]["sessions"]:
        for v in s["verdicts"]:
            if v.get("isCatchTrial"):
                v["verdict"] = "unsure"
    ok, problems, _ = v3pa.check_user(thin, "u1")
    check("too few determinate controls is refused",
          not ok and any("determinate controls" in p for p in problems),
          json.dumps(problems))


def test_cli():
    with tempfile.TemporaryDirectory() as td:
        manifest = write_manifest(td)
        data = pathlib.Path(td) / "auto.json"
        data.write_text(json.dumps(auto_doc()))
        proc = subprocess.run(
            [sys.executable, "-I", str(B / "v3_personal_gate_auto.py"),
             "evaluate", str(data), "u1", "--cg-manifest", str(manifest)],
            capture_output=True, text=True, cwd=td)
        check("CLI evaluate exits 0 on a passing machine-panel document",
              proc.returncode == 0, proc.stderr)
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            payload = {}
        check("CLI evaluate reports the fixed machine-panel label",
              payload.get("gate") == "V3-P-A(machine-panel)")
        check("CLI never writes V3_GATE_RESULT.json",
              not (pathlib.Path(td) / "V3_GATE_RESULT.json").exists())

        bad = subprocess.run(
            [sys.executable, "-I", str(B / "v3_personal_gate_auto.py"),
             "check", str(data), "u1"],
            capture_output=True, text=True, cwd=td, env={"PATH": "/usr/bin:/bin"})
        check("CLI check exits non-zero when the manifest is absent",
              bad.returncode == 1, bad.stdout + bad.stderr)


def main():
    test_function_identity()
    test_differential_hard_gate()
    test_auto_accepts_calibrated_panel()
    test_rejections()
    test_three_state_mapping()
    test_cg_manifest_fail_closed()
    test_pooled_only_unlock()
    test_demotion_deterministic()
    test_sequential_quota_and_reanalysis()
    test_catch_trial_tracks()
    test_cli()

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\nRESULT: {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS"
          + (f"  FAILURES: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())