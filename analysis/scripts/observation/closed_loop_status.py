#!/usr/bin/env python3
"""Closed-loop daily status aggregator (闭环 C 收口, iteration-27 rev2 §7).

Read-only aggregation of the zero-human closed loop's state into one daily
JSON + Markdown report. It ASSERTS NOTHING positive on its own: every field is
either a measured value read from an existing artifact, or "unknown" when the
input is missing/unreadable (fail-closed). It never runs a gate, never writes a
verdict, never deploys, never calls a model.

Inputs (all overridable by env for testability; defaults are the live paths):
  BANDROOM_WINDOW_JSON      production observation window
                            (default ~/.bandroom-acoustic/OBSERVATION_WINDOW.json)
  BANDROOM_WINDOW_VERDICT   production window verdict (optional)
  BANDROOM_RUNNER_STATE     prod runner state.json
                            (default ~/.bandroom-runner-prod/state.json)
  BANDROOM_T2_COUNTS        P0 D1 counts JSON (T2 data adequacy)
                            (default iteration-27/p0/d1_counts.json relative to repo)
  BANDROOM_G5_CHECK         G5-local check_local result JSON (optional)
  BANDROOM_STATUS_OUT       output directory (default iteration-27/status/)

T2 terminal state is derived ONLY from the P0 counts against the frozen V3-P
adequacy floor (>=4 sessions, >=20 future candidates). It reports OFF when the
floor is not met; it never claims a PASS. CG status is read from a CG result
artifact if present, else "deferred" (owner 2026-11-19 decision: 暂缓 CG).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
from datetime import datetime, timezone

HOME = pathlib.Path.home()
REPO = pathlib.Path(__file__).resolve().parents[3]
ITER27 = REPO / "acceptance-2026-11-10" / "iteration-27"

# Frozen V3-P adequacy floor (v3_personal_gate.py:54-56, v3_gate.py:47). These
# are refusal floors, NOT sufficiency; reported here only to explain OFF state.
MIN_SESSIONS = 4
MIN_FUTURE_CANDIDATES = 20


def _env_path(name: str, default: pathlib.Path) -> pathlib.Path:
    v = os.environ.get(name)
    return pathlib.Path(v) if v else default


def _read_json(path: pathlib.Path):
    try:
        return json.loads(path.read_text()), None
    except FileNotFoundError:
        return None, "missing"
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"unreadable: {exc}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def window_state() -> dict:
    path = _env_path("BANDROOM_WINDOW_JSON",
                     HOME / ".bandroom-acoustic" / "OBSERVATION_WINDOW.json")
    doc, err = _read_json(path)
    if doc is None:
        return {"status": "unknown", "reason": err, "source": str(path)}
    nw = doc.get("new_window") or {}
    out = {
        "status": "ok",
        "source": str(path),
        "start": nw.get("start"),
        "scheduled_end": nw.get("scheduled_end"),
        "worker_version": nw.get("worker_version"),
        "verdict": nw.get("verdict"),
    }
    vpath = _env_path("BANDROOM_WINDOW_VERDICT",
                      HOME / ".bandroom-acoustic" / "OBSERVATION_WINDOW_VERDICT.json")
    vdoc, verr = _read_json(vpath)
    out["verdict_file"] = ({"verdict": vdoc.get("verdict"),
                            "evaluatedAt": vdoc.get("evaluatedAt")}
                           if vdoc else {"status": "unknown", "reason": verr})
    return out


def runner_state() -> dict:
    path = _env_path("BANDROOM_RUNNER_STATE",
                     HOME / ".bandroom-runner-prod" / "state.json")
    doc, err = _read_json(path)
    if doc is None:
        return {"status": "unknown", "reason": err, "source": str(path)}
    last = doc.get("lastRun") or {}
    cost = doc.get("cost") or {}
    return {
        "status": "ok",
        "source": str(path),
        "last_run_fatal": last.get("fatal"),
        "last_run_processed": last.get("processed"),
        "last_run_failed": last.get("failed"),
        "last_run_detail": last.get("detail"),
        "cost_spent_cny_today": cost.get("spentCny"),
        "cost_utc_day": cost.get("utcDay"),
        "cost_paused": cost.get("paused"),
    }


def t2_state() -> dict:
    path = _env_path("BANDROOM_T2_COUNTS", ITER27 / "p0" / "d1_counts.json")
    doc, err = _read_json(path)
    if doc is None:
        return {"status": "unknown", "reason": err, "source": str(path),
                "t2": "unknown"}
    sessions = (doc.get("sessions") or {}).get("recordingsWithCandidates")
    cand = doc.get("candidates") or {}
    total = cand.get("total")
    future = cand.get("future")
    controls = cand.get("catchTrials", cand.get("catch_trials"))
    adequate = (isinstance(sessions, int) and sessions >= MIN_SESSIONS
                and isinstance(future, int) and future >= MIN_FUTURE_CANDIDATES)
    return {
        "status": "ok",
        "source": str(path),
        "sessions_with_candidates": sessions,
        "candidates_total": total,
        "future_candidates": future,
        "catch_trials": controls,
        "adequacy_floor": {"min_sessions": MIN_SESSIONS,
                           "min_future_candidates": MIN_FUTURE_CANDIDATES},
        "adequacy_met": bool(adequate),
        # T2 was formally RETIRED (owner 2026-11-19, option A): structurally
        # unreachable for a single low-volume user (data-volume floor + independent
        # precision ceiling + low-prior CG). Permanent posture, not a future unlock.
        # This aggregator never asserts unlock.
        "retired": True,
        "t2": "RETIRED (structurally unreachable; owner 2026-11-19) — "
              + ("data adequacy floor not met" if not adequate
                 else "data floor met but retirement stands (precision ceiling + low-prior CG)"),
        "note": "T2 retired, not pending. >=20 is a refusal floor, not statistical "
                "sufficiency; the precision ceiling (Wilson LB >=0.70 vs detector "
                "oracle ~0.7033) is independent of data volume. V3 machinery remains "
                "as versioned research tooling, not a product promise.",
    }


def cg_state() -> dict:
    path = _env_path("BANDROOM_CG_RESULT", ITER27 / "cg" / "CG_RESULT.json")
    doc, err = _read_json(path)
    if doc is None:
        return {"status": "deferred",
                "reason": "owner 2026-11-19 decision: 暂缓 CG (main path NOT MET; "
                          "SpeechOcean762 format needs forced alignment + prereg "
                          "clarification). No CG result fabricated.",
                "source": str(path)}
    return {"status": "ok", "source": str(path),
            "pass": doc.get("PASS"), "label": doc.get("label")}


def g5_state() -> dict:
    path = _env_path("BANDROOM_G5_CHECK", ITER27 / "g5-discharge" / "check_local.json")
    doc, err = _read_json(path)
    if doc is None:
        return {"status": "unknown", "reason": err, "source": str(path)}
    return {"status": "ok", "source": str(path),
            "passed": doc.get("passed"), "total": doc.get("total"),
            "waived": doc.get("waived"),
            "label": doc.get("label", "G5-owner-attested(single-root-four-key)")}


def build_status() -> dict:
    return {
        "schema": "bandroom-closed-loop-status-v1",
        "generatedAt": _now(),
        "fail_closed": True,
        "production_window": window_state(),
        "runner": runner_state(),
        "t2_calibration": t2_state(),
        "cg_calibration_gate": cg_state(),
        "g5_owner_attested": g5_state(),
        "human_maintenance_remaining": [
            "DashScope/CF credential renewal & rotation",
            "Ed25519 key rotation (re-sign + re-verify on rotation)",
            "upstream model deprecation/change -> panel recalibration",
            "major host/OS environment change",
        ],
    }


def render_markdown(s: dict) -> str:
    pw = s["production_window"]
    rn = s["runner"]
    t2 = s["t2_calibration"]
    cg = s["cg_calibration_gate"]
    g5 = s["g5_owner_attested"]
    lines = [
        f"# Bandroom 闭环每日状态 — {s['generatedAt']}",
        "",
        "## 生产观察窗",
        f"- 状态: {pw.get('status')}；verdict: {pw.get('verdict', 'unknown')}",
        f"- 窗: {pw.get('start')} → {pw.get('scheduled_end')}",
        f"- Worker: {pw.get('worker_version')}",
        "",
        "## Runner",
        f"- 状态: {rn.get('status')}；fatal={rn.get('last_run_fatal')} "
        f"processed={rn.get('last_run_processed')} failed={rn.get('last_run_failed')}",
        f"- 今日花费: ¥{rn.get('cost_spent_cny_today')}（{rn.get('cost_utc_day')}）",
        "",
        "## T2 个人校准",
        f"- {t2.get('t2', 'unknown')}",
        f"- 会话={t2.get('sessions_with_candidates')} 候选={t2.get('candidates_total')} "
        f"未来候选={t2.get('future_candidates')} 控制项={t2.get('catch_trials')}",
        f"- 数据充分性达标: {t2.get('adequacy_met')}",
        "",
        "## CG 校准门",
        f"- {cg.get('status')}: {cg.get('reason', cg.get('pass', ''))}",
        "",
        "## G5-owner-attested",
        f"- 状态: {g5.get('status')}；check_local {g5.get('passed')}/{g5.get('total')} "
        f"豁免 {g5.get('waived')}",
        "",
        "## 残留 owner 维护项（未自动化）",
    ]
    lines += [f"- {m}" for m in s["human_maintenance_remaining"]]
    lines += ["", "> 本报告只读聚合，fail-closed：缺失输入记 unknown，绝不自行断言 PASS/解锁。"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=pathlib.Path, default=None,
                    help="output directory (default BANDROOM_STATUS_OUT or iteration-27/status)")
    ap.add_argument("--print", action="store_true", help="print markdown to stdout")
    args = ap.parse_args(argv)
    out = args.out or _env_path("BANDROOM_STATUS_OUT", ITER27 / "status")
    out.mkdir(parents=True, exist_ok=True)
    status = build_status()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (out / f"closed-loop-status-{stamp}.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2))
    md = render_markdown(status)
    (out / f"closed-loop-status-{stamp}.md").write_text(md)
    (out / "closed-loop-status-latest.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2))
    if args.print:
        print(md)
    print("wrote", out / f"closed-loop-status-{stamp}.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
