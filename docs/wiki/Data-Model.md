# Data Model

D1 (SQLite) via Drizzle; migrations `drizzle/0000…0007`. R2 holds recordings, backups, and analysis bundles.

## Core tables

- `learner_states` — per-user JSON ledger + revision (optimistic concurrency).
- `teacher_feedback` — coach feedback; `analysis_json` persists grounded analysis (with server-issued `candidateId`s) on both review-task and legacy v1 paths.
- `teacher_lessons` — coach-authored adaptive packs (Day 17–62).
- `review_jobs` / review tasks — runner job queue with leases, checkpoints, receipts.
- `submissions` — idempotent answer/recording commits (`submissionKey`).

## Calibration (0007)

- `personal_calibration` — per `(user,expected,actual)` counters (confirmed/rejected/unsure) + state.
- `calibration_candidates` — server-issued candidates per attempt.
- `calibration_events` — three-state verdicts, `is_catch_trial`, idempotent unique index.

## Backup format 4

Signed archive of state, reports, lessons, feedback, and referenced recordings; formats 1–3 still importable (no silent clearing). Restore verifies signature, account, and digests before preview/apply; conflicts stop rather than overwrite. Single archive ≤ 512 MiB, per-recording ≤ 12 MiB.

## Isolation

All learner rows keyed by stable `userId`; no cross-user reads. Service identities cannot write human verdicts.
