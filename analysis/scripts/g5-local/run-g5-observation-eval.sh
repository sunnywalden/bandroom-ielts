#!/usr/bin/env bash
# Independent G5 24h local observation window — launchd entry point.
#
# This is deliberately SEPARATE from the production observation evaluator
# (com.bandroom.observation-eval). It never reads or writes
# ~/.bandroom-acoustic/OBSERVATION_WINDOW*.json; all state lives under
# ~/.bandroom-g5-local/observation/ via BANDROOM_G5_* env paths.
#
# Each scheduled wake:
#   1. opens the window on the first wake (start=now, scheduled_end=+24h);
#   2. appends one genuine local-scheduler wake record;
#   3. runs the frozen G5 evaluator (writes a verdict only at/after end).
# Once a verdict exists for this window the job goes quiescent.
#
# Canonical source: analysis/scripts/g5-local/run-g5-observation-eval.sh.
# macOS TCC: launchd cannot read ~/Documents, so mirror this file and
# g5_observation_eval.py to ~/.bandroom-g5-local/bin/ and run that copy.
set -uo pipefail

ROOT="${BANDROOM_G5_ROOT:-$HOME/.bandroom-g5-local}"
OBS="$ROOT/observation"
BIN="$ROOT/bin"
LABEL="com.bandroom.g5-observation-eval"

export BANDROOM_G5_WINDOW="$OBS/window.json"
export BANDROOM_G5_VERDICT="$OBS/verdict.json"
export BANDROOM_G5_WAKES="$OBS/wakes.json"
export BANDROOM_G5_LAUNCHD_LABEL="$LABEL"
# C7 (remote health probe) is intentionally NOT set: this window measures only
# local scheduler behaviour and must not touch the production site.
unset BANDROOM_G5_HEALTH_URL 2>/dev/null || true

mkdir -p "$OBS/logs"
PY="${BANDROOM_G5_PYTHON:-python3}"

"$PY" -I - "$OBS" "$LABEL" <<'PY'
import fcntl, json, os, sys, uuid
from datetime import datetime, timedelta, timezone

obs, label = sys.argv[1], sys.argv[2]
win_path = os.path.join(obs, "window.json")
wakes_path = os.path.join(obs, "wakes.json")
verdict_path = os.path.join(obs, "verdict.json")
lock_path = os.path.join(obs, "run.lock")


def load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def save(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


now_dt = datetime.now(timezone.utc)
now = now_dt.isoformat()

with open(lock_path, "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    window = load(win_path, {})
    current = window.get("new_window") or {}
    start = current.get("start")

    verdict = load(verdict_path, None)
    if start and isinstance(verdict, dict) and verdict.get("window_start") == start:
        print("G5 window already has a verdict; job quiescent")
        sys.exit(10)

    if not start:
        window = {
            "schema": "bandroom-g5-observation-window-v1",
            "new_window": {
                "start": now,
                "scheduled_end": (now_dt + timedelta(seconds=86400)).isoformat(),
                "failClosed": True,
                "manualInterventions": 0,
                "profile": "G5-owner-attested(single-root-four-key)",
                "schedulerLabel": label,
                "scope": (
                    "independent local 24h G5 observation: the signed launchd "
                    "evaluator job is the local scheduled wake; no production "
                    "site or production observation window is touched"
                ),
                "verdict": "IN PROGRESS — no verdict claimed before scheduled_end",
            },
        }
        start = now
        save(win_path, window)

    wakes_doc = load(wakes_path, {"wakes": []})
    wakes = wakes_doc.get("wakes") if isinstance(wakes_doc, dict) else wakes_doc
    if not isinstance(wakes, list):
        wakes = []
    wakes.append({
        "at": now,
        "source": label,
        "officialRunId": "g5obs-" + uuid.uuid4().hex,
        "approvalPrompts": 0,
        "fatal": False,
        "errors": [],
    })
    save(wakes_path, {"wakes": wakes})
    print(f"G5 wake recorded at {now} (total {len(wakes)})")
PY
rc=$?
if [ "$rc" -eq 10 ]; then
  exit 0
elif [ "$rc" -ne 0 ]; then
  echo "G5 wake recording failed (rc=$rc); refusing to evaluate" >&2
  exit "$rc"
fi

exec "$PY" -I "$BIN/g5_observation_eval.py"