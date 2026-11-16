#!/usr/bin/env python3
"""Production data -> V3 gate input. The missing path that blocked T2 forever.

Before this tool existed there was NO route from the site's D1 tables to the
`bandroom-v3-multisession-v1` document that v3_gate.py consumes, so even with
years of usage the gate could never be run. Three subcommands close that gap:

  readiness  how far the live data is from the frozen V3 requirements
  export     D1 -> gate-schema JSON (groundTruth left null, awaiting humans)
  annotate   interactive HUMAN annotation; the gate rejects detector labels

The gate's requirements are frozen and are NOT relaxed here:
  >= 2 strictly time-ordered sessions per user, >= 6 users,
  >= 20 future-session candidates per user, human ground truth, catch trials.

Nothing here manufactures data. If the corpus is inadequate the tool says so.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.request

# Deployment identifiers stay out of the repository, matching the project's
# practice of gitignoring config.{prod,qa}.toml. Supply them via the environment.
DB_ID_ENV = {"prod": "BANDROOM_D1_PROD_ID", "qa": "BANDROOM_D1_QA_ID"}


def db_id(database: str) -> str:
    name = DB_ID_ENV[database]
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} must be set to the {database} D1 database id")
    return value
SCHEMA = "bandroom-v3-multisession-v1"
MIN_SESSIONS_PER_USER = 2
MIN_USERS = 6
MIN_FUTURE_CANDIDATES = 20
# Must match lib/calibration.ts; a non-discriminating listener's verdicts are
# uninformative and cannot support a calibration claim.
CATCH_TRIAL_MIN_ANSWERED = 5
CATCH_TRIAL_CONFIRM_RATE_FLAG = 0.8


def d1_query(database: str, sql: str) -> list[dict]:
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        raise SystemExit("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN must be set")
    url = (f"https://api.cloudflare.com/client/v4/accounts/{account}"
           f"/d1/database/{db_id(database)}/query")
    req = urllib.request.Request(
        url, data=json.dumps({"sql": sql}).encode(),
        headers={"Authorization": f"Bearer {token}", "content-type": "application/json"})
    payload = json.loads(urllib.request.urlopen(req, timeout=90).read())
    if not payload.get("success"):
        raise SystemExit(f"D1 query failed: {payload.get('errors')}")
    return payload["result"][0].get("results") or []


def collect(database: str) -> dict:
    """Read candidates, verdicts and session metadata; group into sessions."""
    candidates = d1_query(database, """
        SELECT candidate_id, user_id, attempt_id, recording_id, word, expected, actual,
               at_ms, detector_confidence, shown_at, answered_at
        FROM calibration_candidates ORDER BY user_id, shown_at, at_ms""")
    events = d1_query(database, """
        SELECT candidate_id, user_id, verdict, is_catch_trial, created_at
        FROM calibration_events ORDER BY created_at""")
    receipts = d1_query(database, """
        SELECT attempt_id, user_id, recording_sha256, created_at
        FROM review_receipts""")
    feedback = d1_query(database, """
        SELECT attempt, user_id, analysis_json FROM teacher_feedback
        WHERE analysis_json IS NOT NULL""")

    sha_by_attempt = {(r["user_id"], r["attempt_id"]): r.get("recording_sha256")
                      for r in receipts}
    speech_by_attempt: dict[tuple, float] = {}
    for row in feedback:
        try:
            analysis = json.loads(row["analysis_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        seconds = analysis.get("speechSeconds")
        if isinstance(seconds, (int, float)):
            speech_by_attempt[(row["user_id"], row["attempt"])] = float(seconds)

    verdict_by_candidate: dict[str, dict] = {}
    for event in events:
        verdict_by_candidate[event["candidate_id"]] = {
            "candidateId": event["candidate_id"],
            "verdict": event["verdict"],
            "isCatchTrial": bool(event["is_catch_trial"]),
        }

    # A session is one recording. Time order comes from when it was shown.
    sessions: dict[tuple, dict] = {}
    for row in candidates:
        key = (row["user_id"], row["recording_id"])
        session = sessions.setdefault(key, {
            "sessionId": row["recording_id"],
            "recordedAt": row["shown_at"],
            "audioSha256": sha_by_attempt.get((row["user_id"], row["attempt_id"])),
            "speechSeconds": speech_by_attempt.get((row["user_id"], row["attempt_id"]), 0.0),
            "candidates": [],
            "verdicts": [],
        })
        session["recordedAt"] = min(session["recordedAt"], row["shown_at"])
        session["candidates"].append({
            "candidateId": row["candidate_id"],
            "word": row["word"],
            "expected": row["expected"],
            "actual": row["actual"],
            "atMs": row["at_ms"],
            "detectorConfidence": row["detector_confidence"],
            # Never inferred. The gate refuses detector-labelled truth.
            "groundTruth": None,
            "_attemptId": row["attempt_id"],
            "_recordingId": row["recording_id"],
        })
        verdict = verdict_by_candidate.get(row["candidate_id"])
        if verdict:
            session["verdicts"].append(verdict)

    users: dict[str, list] = {}
    for (user_id, _recording), session in sessions.items():
        users.setdefault(user_id, []).append(session)
    for user_sessions in users.values():
        user_sessions.sort(key=lambda s: s["recordedAt"])
        for session in user_sessions:
            from datetime import datetime, timezone
            millis = session["recordedAt"]
            session["recordedAt"] = datetime.fromtimestamp(
                millis / 1000.0, tz=timezone.utc).isoformat()
    return {"schema": SCHEMA,
            "users": [{"userId": uid, "sessions": sess} for uid, sess in sorted(users.items())]}


def readiness(document: dict) -> dict:
    users = document.get("users") or []
    per_user = []
    adequate_users = 0
    for user in users:
        sessions = user.get("sessions") or []
        future = sessions[1:] if len(sessions) >= MIN_SESSIONS_PER_USER else []
        future_candidates = sum(len(s.get("candidates") or []) for s in future)
        annotated = sum(1 for s in sessions for c in (s.get("candidates") or [])
                        if (c.get("groundTruth") or {}).get("annotatedBy") == "human")
        total = sum(len(s.get("candidates") or []) for s in sessions)
        catch = sum(1 for s in sessions for v in (s.get("verdicts") or []) if v.get("isCatchTrial"))
        # The gate refuses detector-labelled truth, so a user is only adequate
        # when EVERY future-session candidate carries human annotation. Counting
        # sessions alone would report "ready" for a corpus the gate rejects.
        future_total = future_candidates
        future_annotated = sum(
            1 for s in future for c in (s.get("candidates") or [])
            if (c.get("groundTruth") or {}).get("annotatedBy") == "human")
        # A listener who confirms most controls is not discriminating, so their
        # verdicts carry no information and must not count toward V3. Mirrors
        # the server rule (lib/calibration.ts CATCH_TRIAL_* constants).
        control_verdicts = [v for s in sessions for v in (s.get("verdicts") or [])
                            if v.get("isCatchTrial")]
        control_confirmed = sum(1 for v in control_verdicts if v.get("verdict") == "confirmed")
        control_answered = len(control_verdicts)
        constant_confirmer = (control_answered >= CATCH_TRIAL_MIN_ANSWERED
                              and control_confirmed / control_answered >= CATCH_TRIAL_CONFIRM_RATE_FLAG)
        ok = (len(sessions) >= MIN_SESSIONS_PER_USER
              and future_candidates >= MIN_FUTURE_CANDIDATES
              and future_total > 0 and future_annotated == future_total
              and not constant_confirmer)
        adequate_users += int(ok)
        per_user.append({
            "userId": user["userId"], "sessions": len(sessions),
            "candidates": total, "futureCandidates": future_candidates,
            "futureHumanAnnotated": future_annotated,
            "humanAnnotated": annotated, "catchTrials": catch,
            "controlsAnswered": control_answered,
            "controlsConfirmed": control_confirmed,
            "constantConfirmer": constant_confirmer,
            "adequate": ok,
        })
    return {
        "users": len(users),
        "minUsersRequired": MIN_USERS,
        "adequateUsers": adequate_users,
        "totalCandidates": sum(u["candidates"] for u in per_user),
        "totalHumanAnnotated": sum(u["humanAnnotated"] for u in per_user),
        "totalCatchTrials": sum(u["catchTrials"] for u in per_user),
        "perUser": per_user,
        "readyForGate": (adequate_users >= MIN_USERS
                         and sum(u["catchTrials"] for u in per_user) > 0),
        "blockers": [
            b for b in [
                None if len(users) >= MIN_USERS else f"need >= {MIN_USERS} users, have {len(users)}",
                None if adequate_users >= MIN_USERS else
                f"need >= {MIN_USERS} users with >= {MIN_SESSIONS_PER_USER} sessions and "
                f">= {MIN_FUTURE_CANDIDATES} future candidates, have {adequate_users}",
                None if sum(u["humanAnnotated"] for u in per_user) > 0 else
                "no HUMAN ground truth yet; the gate rejects detector labels",
                None if all(u["futureHumanAnnotated"] == u["futureCandidates"]
                            for u in per_user if u["futureCandidates"]) else
                "some future-session candidates lack human annotation; "
                "the gate needs every future candidate labelled",
                None if sum(u["catchTrials"] for u in per_user) > 0 else
                "no catch trials recorded yet",
                None if not any(u["constantConfirmer"] for u in per_user) else
                "some users confirm most control items; their verdicts are "
                "uninformative and are excluded from adequacy",
            ] if b
        ],
    }


def annotate(document: dict, output: pathlib.Path) -> dict:
    """Interactive human annotation. Requires a real listener; never auto-fills."""
    pending = [(u, s, c) for u in document["users"] for s in u["sessions"]
               for c in s["candidates"] if not c.get("groundTruth")]
    if not pending:
        print("nothing to annotate")
        return document
    print(f"{len(pending)} candidates need HUMAN annotation.")
    print("Listen to the recording at the timestamp before answering.")
    print("Answers: y = real error, n = not an error, s = skip, q = quit\n")
    answered = 0
    for user, session, candidate in pending:
        print(f"user {user['userId']}  recording {candidate['_recordingId']}")
        print(f"  {candidate['word']}  {candidate['expected']} -> {candidate['actual']}"
              f"  @ {candidate['atMs']} ms  (conf {candidate['detectorConfidence']})")
        try:
            answer = input("  real error? [y/n/s/q] ").strip().lower()
        except EOFError:
            break
        if answer == "q":
            break
        if answer not in ("y", "n"):
            continue
        try:
            start = int(input("  interval start ms: ").strip())
            end = int(input("  interval end ms: ").strip())
        except (EOFError, ValueError):
            continue
        if end <= start:
            print("  end must be after start; skipped")
            continue
        candidate["groundTruth"] = {
            "isTrueError": answer == "y",
            "annotatedBy": "human",
            "intervalStartMs": start,
            "intervalEndMs": end,
        }
        answered += 1
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2))
    print(f"\nannotated {answered}; wrote {output}")
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["readiness", "export", "annotate", "personal"])
    parser.add_argument("--db", choices=sorted(DB_ID_ENV), default="prod")
    parser.add_argument("--input", type=pathlib.Path, help="annotate: existing export")
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--user", help="personal: userId to evaluate with V3-P")
    args = parser.parse_args()

    if args.mode == "personal":
        # V3-P answers "is THIS user's calibration reliable?" from their own
        # sessions. It does not require other users, so it is not tied to
        # acquisition. A PASS enables T2 for that user only.
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        import v3_personal_gate
        document = (json.loads(args.input.read_text()) if args.input
                    else collect(args.db))
        users = [u["userId"] for u in document.get("users") or []]
        target = args.user or (users[0] if len(users) == 1 else None)
        if not target:
            raise SystemExit(f"--user required; document has {len(users)} users")
        result = v3_personal_gate.evaluate_user(document, target)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("PASS") else 1

    if args.mode == "annotate":
        if not args.input:
            raise SystemExit("annotate requires --input (a previous export)")
        document = json.loads(args.input.read_text())
        out = args.output or args.input
        annotate(document, out)
        return 0

    document = collect(args.db)
    report = readiness(document)
    if args.mode == "readiness":
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["readyForGate"] else 1

    out = args.output or pathlib.Path.cwd() / f"v3_export_{args.db}.json"
    out.write_text(json.dumps(document, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nwrote {out}")
    print("groundTruth is null everywhere: run `annotate` with a human listener next.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
