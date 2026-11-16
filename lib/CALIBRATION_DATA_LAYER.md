# Pronunciation calibration data + MCP layer

Implementation of the reviewed design rev2 §8/§9 (FIX-15, FIX-16, FIX-17,
FIX-22, FIX-28). This layer stores the owner's self-listen verdicts for
server-issued pronunciation candidates, exposes three MCP tools, and makes the
personal calibration survive a backup/restore. It does **not** change the
sealed runner files or deploy anything.

Scope note: the current stack is **single-owner**. Every table carries
`user_id` and every query is scoped by the authenticated session user, but
onboarding a second user additionally requires an auth-scope redesign, the P5
clean-licence retrain, and a PIPL/GDPR consent / DPA / retention design
(rev2 §10, FIX-28). Do not treat the presence of `user_id` as multi-tenant
authorization.

## 1. Schema (migration `drizzle/0007_slimy_boomerang.sql`)

Additive only: existing tables are unchanged. All timestamps are epoch
milliseconds (`integer`), matching `review_tasks` and `review_receipts`.

### `personal_calibration`

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | text | PK part 1; from the session, never from a tool argument |
| `expected` | text | canonical ARPABET symbol (e.g. `TH`) |
| `actual` | text | canonical ARPABET symbol (e.g. `S`) |
| `n_confirmed`, `n_rejected`, `n_unsure` | integer | verdict counts, excluding catch trials |
| `n_shown` | integer | number of non-catch candidates shown for this category |
| `state` | text | `CANDIDATE` or `SUPPRESSED`; `TRUSTED` is never derived yet |
| `rule_version` | text | e.g. `r6-suppress-1` |
| `detector_version` | text | set at first issuance (FIX-17) |
| `inventory_version` | text | set at first issuance (FIX-17) |
| `updated_at` | integer | last issuance/verdict write |

Primary key: `(user_id, expected, actual)`. Index:
`personal_calibration_user_state (user_id, state)`.

`SUPPRESSED` uses the measured R6 rule from rev2 §4.1: `n_rejected > n_confirmed
AND n_rejected >= 2`. TRUSTED promotion (Beta lower credible bound) remains
**disabled** until the V3 gate passes, so this layer never writes `TRUSTED`.
The FIX-14 user-level "≤50% of shown categories may be SUPPRESSED" cap and its
user-level transaction are a policy layer on top of this per-category state; they
are not applied in this data layer (the R6 rule already self-limits at large N).

### `calibration_candidates`

| Column | Type | Notes |
| --- | --- | --- |
| `candidate_id` | text PK | server-generated opaque id (this implementation uses `crypto.randomUUID()`) |
| `user_id` | text | owner of the display |
| `attempt_id`, `recording_id` | text | source attempt/audio |
| `word` | text | displayed word |
| `expected`, `actual` | text | canonical ARPABET pair |
| `at_ms` | integer | detector timestamp in milliseconds |
| `detector_confidence` | real | 0..1 posterior/score from the detector |
| `shown_at` | integer | when the server issued the display record |
| `answered_at` | integer nullable | first verdict time; retries do not change it |

Index: `calibration_candidates_user_attempt (user_id, attempt_id)`.

A **catch trial** is a canonical correct item and is stored as
`expected === actual`. `is_catch_trial` is therefore derived server-side from
the immutable candidate row; the client never supplies it and cannot turn a
real error into a catch trial or vice versa.

### `calibration_events`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer PK autoincrement | append-only |
| `user_id` | text | session user |
| `attempt_id` | text | copied from the candidate |
| `candidate_id` | text | copied from the candidate |
| `expected`, `actual` | text | denormalised from the candidate |
| `verdict` | text | `confirmed` / `rejected` / `unsure` |
| `is_catch_trial` | integer bool | derived from `expected === actual` |
| `created_at` | integer | server time |

Unique index (`calibration_events_candidate`):
`(user_id, attempt_id, candidate_id)` — the idempotency contract.
Index (`calibration_events_profile`): `(user_id, expected, actual)` — serves
profile recomputation without a join. (`expected`/`actual` are denormalised
because rev2 §8 requires this index on the event table.)

`id` is deliberately **not** carried in a backup manifest. The stable event
identity is `(user_id, attempt_id, candidate_id)`; the local autoincrement id
may differ after a restore, and omitting it avoids colliding with an existing
event id.

## 2. Candidate issuance (server-side, not an MCP tool)

`issueCalibrationCandidates(db, userId, input)` in `lib/calibration.ts` is
called by the feedback/analysis pipeline after it has produced calibrated
phoneme candidates. It is intentionally **not** exposed as an MCP tool, so a
client cannot mint a `candidateId` or choose the `(word, expected, actual,
atMs)` tuple.

Input shape:

```ts
{
  attemptId: string, recordingId: string,
  detectorVersion: string, inventoryVersion: string,
  ruleVersion?: string,                       // default "r6-suppress-1"
  candidates: [{
    word: string,
    expected: string, actual: string,         // canonical ARPABET
    atMs: number, detectorConfidence: number, // 0..1
    catchTrial?: boolean                      // forces expected = actual
  }]
}
```

Output: `{ candidateIds: string[], issuedAt: number }`.

Behavior: one candidate row per item with a fresh UUID; each non-catch item
atomically increments `n_shown` for its category and creates the profile row
with the supplied detector/inventory versions. If an existing profile row for
that category was produced by a different detector or inventory version,
issuance throws `detector_version_mismatch` (fail closed) instead of silently
mixing counts — rev2 FIX-17 requires a mapped migration or a reset in that case.
Callers should issue once per completed analysis; re-issuing the same candidates
creates new display rows and increments `n_shown` again, because that is the
observation the learner actually saw.

Wiring this call into the completed-analysis path (`complete_review_task` /
`output.analysis` candidate extraction) belongs to the feedback-contract
workstream; the sealed runner files were not modified here. This module is the
only supported way to create a `candidateId`.

## 3. MCP tool contracts

All three tools are registered in `lib/mcp-scope.ts` (`MCP_TOOL_SCOPES` is a
closed whitelist; an unregistered tool is denied even if it appears in
`coachTools`). All input schemas are `z.strictObject`, so an unexpected field —
including `userId` — is rejected. `userId` always comes from
`auth.user.userId` in `app/mcp/route.ts`.

Intended scopes:

| Tool | owner | coach | coach-runner | Read-only |
| --- | --- | --- | --- | --- |
| `record_pronunciation_verdict` | yes | no | no | no |
| `read_pronunciation_profile` | yes | yes | yes | yes |
| `reset_pronunciation_profile` | yes | no | no | no (destructive) |

The verdict and reset tools are owner-only because they record or erase the
learner's own self-report. The runner may read the profile to condition T2
suggestions. This is not a multi-user authorization model; see §8.

### `record_pronunciation_verdict`

Input (strict; **no userId**):

```json
{ "candidateId": "opaque-server-id", "verdict": "confirmed" | "rejected" | "unsure" }
```

The user and `attemptId` are resolved from `calibration_candidates` by
`(candidate_id, user_id)`. A candidateId that was not issued to this user is
rejected exactly like a forged one (`candidate_not_found`), without revealing
whether it exists for another user.

Output (success):

```json
{
  "saved": true,
  "duplicate": false,
  "candidateId": "uuid",
  "verdict": "confirmed",
  "attemptId": "attempt-1",
  "isCatchTrial": false,
  "event": {
    "id": 1, "attemptId": "attempt-1", "candidateId": "uuid",
    "expected": "TH", "actual": "S", "verdict": "confirmed",
    "isCatchTrial": false, "createdAt": 1794795581771
  },
  "profile": {
    "expected": "TH", "actual": "S",
    "nConfirmed": 1, "nRejected": 0, "nUnsure": 0, "nShown": 1,
    "state": "CANDIDATE", "ruleVersion": "r6-suppress-1",
    "detectorVersion": "detector-v1", "inventoryVersion": "arpabet-v1",
    "updatedAt": 1794795581771
  }
}
```

`profile` is `null` for a catch trial (catch answers are control items and are
excluded from counts). On a retry/replay `duplicate` is `true` and the original
event is returned; if the retry supplies a different verdict, the **first**
verdict wins and counts do not change.

Surfaced errors (`isError: true`, text JSON):

- `invalid_input` — schema violation, including a client-supplied `userId`.
- `candidate_not_found` — forged, replayed from another user, or unknown.
- `detector_version_mismatch` — issuance only.
- `user_required`, `event_write_failed`.

### `read_pronunciation_profile`

Input: `{}` (strict).

Output:

```json
{
  "rows": [{
    "expected": "TH", "actual": "S",
    "nConfirmed": 2, "nRejected": 0, "nUnsure": 0, "nShown": 3,
    "state": "CANDIDATE", "ruleVersion": "r6-suppress-1",
    "detectorVersion": "detector-v1", "inventoryVersion": "arpabet-v1",
    "updatedAt": 1794795581771
  }],
  "classes": [/* same rows; alias used by the UI normalizer */],
  "totals": {
    "nConfirmed": 2, "nRejected": 0, "nUnsure": 0,
    "nShown": 3, "categories": 1
  },
  "notes": {
    "scope": "single-owner",
    "trustPromotion": "disabled-pending-v3",
    "countsExcludeCatchTrials": true,
    "voiceMayBeBiometric": true
  }
}
```

Rows are ordered by `n_shown DESC, expected, actual`. Only this user's rows are
returned. Catch-trial answers never appear in the counts.

### `reset_pronunciation_profile`

Input: `{}` (strict).

Output:

```json
{
  "deleted": { "events": 7, "candidates": 8, "profileRows": 4 },
  "retained": ["r2_recordings", "backups", "feedback", "review_artifacts"]
}
```

Deletes, in one D1 transaction, that user's `calibration_events`,
`calibration_candidates` and `personal_calibration` rows. Another user's rows
are untouched (tested).

**What reset does NOT delete** (FIX-28; also stated in the tool description):

- R2 audio objects (`speaking/<userId>/<recordingId>`) — the voice recordings
  referenced by the candidates remain;
- exported `.bandroom` backup archives and the R2 objects they contain;
- `teacher_feedback`, `review_tasks`, `review_receipts`, `analysis_artifacts`,
  or any other learning record.

PIPL/GDPR erasure of voice audio is therefore **not** satisfied by this tool.
It needs a separate recording and backup deletion workflow (and an operator
decision about backups already downloaded by the user). Voice may be biometric
personal data under PIPL/GDPR; a multi-user deployment needs consent, retention
limits and a DPA **before** onboarding a second user.

## 4. Idempotency mechanism

1. `calibration_events` has `UNIQUE(user_id, attempt_id, candidate_id)`.
2. The verdict insert is `INSERT ... ON CONFLICT(user_id, attempt_id,
   candidate_id) DO NOTHING`.
3. Before writing, the handler reads any prior event. After the batch it checks
   `meta.changes` (D1 exposes it) to decide whether this call inserted; if an
   adapter omits `meta.changes`, the pre-read is the fallback.
4. The stored event is read back and returned. `answered_at` uses
   `COALESCE(answered_at, ?)`, so the first answer time is preserved.
5. Catch trials and duplicates never increment `n_shown`.
6. A reset committing between the candidate pre-read and the verdict batch is
   authoritative: the event insert is guarded by
   `WHERE EXISTS (SELECT 1 FROM calibration_candidates ...)`, and the profile
   rebuild has `HAVING COUNT(*) > 0`. A racing reset therefore leaves no orphan
   event and cannot recreate a zero-count profile row (tested).

Tests cover: same verdict twice, a conflicting replay (first verdict wins), and
two concurrent replays of the same candidate (exactly one event row and one
count increment, on both SQLite and Miniflare D1).

## 5. Transaction strategy (no lost increments)

D1 `batch()` executes its statements as one transaction. Counts are never
read-modified-written in application code:

- **`n_shown`** is incremented by an atomic UPSERT:
  `ON CONFLICT ... DO UPDATE SET n_shown = personal_calibration.n_shown + 1`.
- **verdict counts** are **event-sourced**: the batch inserts the event and then
  recomputes `n_confirmed/n_rejected/n_unsure/state` for that
  `(user_id, expected, actual)` from all non-catch events in
  `calibration_events`. A duplicate insert leaves the recomputation unchanged; a
  concurrent device's committed event is included by the next transaction, so
  increments cannot be lost. `n_shown` is preserved by the recompute's
  `ON CONFLICT DO UPDATE` clause.
- `state` is recomputed in the same statement from the aggregate counts.

This is the rev2 §8 alternative "single D1 transaction **or** event-sourced
rebuild"; the implementation uses both: an atomic write and a rebuild.

Detector/inventory versions are set when the profile row is first created and
preserved by later verdicts. A detector change must be handled by an explicit
mapped migration or reset; issuance fails closed if the versions differ.

## 6. Backup format 4 (FIX-16)

Format 4 adds three manifest arrays, with no `userId` (the authenticated restore
target owns every row, matching feedback/lessons):

- `personalCalibration[]`
- `calibrationCandidates[]`
- `calibrationEvents[]`

Updated end-to-end: `lib/backup-format.ts` (`Data`, `unpack`),
`lib/backup.ts` (`snapshot`, `exportBackup`, `authentic`, `restoreBackup`,
`compareRows` via the new sections, and the concurrent-change guard) and
`scripts/migrate/import-backup-direct.mjs` (its `TABLES` whitelist).

Export format selection:

1. any calibration row/candidate/event → **format 4** (so an old reader fails
   closed on the unknown format rather than silently dropping the profile);
2. otherwise an analysis/audio-metadata row → format 3;
3. otherwise a review job → format 2;
4. otherwise format 1.

Compatibility matrix:

| Backup | Contains calibration? | Import into empty target | Import into target with calibration |
| --- | --- | --- | --- |
| format 1 | no | yes | N/A (predates calibration; profile must be empty) |
| format 2 | no | yes | conflict if calibration rows exist |
| format 3 | no | yes (new tables stay empty) | conflict if calibration rows exist |
| format 4 | yes | yes | yes, if rows match / are additive |
| format 5+ | — | rejected `422` | rejected `422` |

Restore semantics remain fail-closed: `compareRows` still refuses to proceed if
the current database contains rows absent from the backup. A format-3 backup
against a database that already has calibration rows therefore returns `409`
rather than silently erasing them. The direct importer uses idempotent
`INSERT ... ON CONFLICT DO NOTHING`, and excludes `calibration_events.id` so the
auto-increment cannot collide.

Evidence: `tests/calibration-backup.test.mjs` proves a format-4 export →
`unpack` → restore round-trip preserves all three arrays (SQLite and Miniflare
D1/R2), a format-3 backup still imports into an empty target, a format-3 backup
cannot erase an existing profile, and format 5 is rejected. The existing
`tests/backup.mjs` (formats 1–3) still passes unchanged.

## 7. Isolation model (FIX-22 / MJ-19)

- `personal_calibration`, `calibration_candidates`, `calibration_events` carry
  `user_id` directly; every read/write/delete binds the session user. Writing a
  verdict for another user's candidate is indistinguishable from a forged id
  (`candidate_not_found`). Reset is scoped by `user_id`.
- `analysis_artifacts` has **no** `user_id` column. Isolation is indirect:
  `analysis_artifacts.task_id → review_tasks.id`, then `review_tasks.user_id`.
  `lib/analysis-isolation.ts` provides
  `readAnalysisArtifactsForUser(db, userId, taskId)`, which always joins
  `review_tasks` and constrains `t.user_id = ?`, plus `taskBelongsToUser` for
  write preconditions. The existing checkpoint read/write paths in
  `lib/review-tasks.ts` already use the same `review_tasks ... WHERE user_id=?`
  join. Do not query `analysis_artifacts` by `task_id` alone on a request path.
- Tests: user A cannot read user B's profile/candidates/events, cannot record
  against B's candidateId, and A's reset leaves B's rows untouched. A cannot
  read B's `analysis_artifacts` row; B can read its own.

## 8. Explicit multi-user gaps (do not paper over)

1. **Authorization**: `evaluateOwnerScope` is owner-only and the MCP service
   scopes map to the single configured owner id. Multi-user requires a real
   per-user identity/authorization design; adding rows to `MCP_TOOL_SCOPES` is
   not sufficient.
2. **Licence**: rev2 §10 — the current stack is single-owner. The P5
   clean-licence retrain is a blocking prerequisite for any second user.
3. **Consent/DPA/retention**: no consent UI, DPA or retention policy is
   implemented here. Voice may be biometric data under PIPL/GDPR. Reset deletes
   calibration rows only; audio and backups need a separate erasure workflow.
4. **Catch-trial policy**: the schema and `is_catch_trial` flag are ready, but
   the runner-side insertion rate, anomaly detection (`uninformative_confirmer`)
   and re-probe/downgrade policy belong to the P2 runner/validator workstream
   (rev2 §4.4/§4.5). This layer derives the flag rather than trusting clients.
5. **Version migration**: detector/inventory changes fail closed on issuance.
   A mapped profile migration and user notification (rev2 FIX-17, V5) are not
   implemented; reset is the only current remedy.
6. **Backups of other users**: the backup implementation is owner-scoped and has
   not been designed for a multi-tenant archive.

## 9. Commands and evidence

```sh
# New data/backup/isolation tests (SQLite and real Miniflare D1)
node tests/calibration.test.mjs
node --import ./scripts/sites-env.mjs tests/calibration.test.mjs --miniflare
node tests/calibration-backup.test.mjs
node --import ./scripts/sites-env.mjs tests/calibration-backup.test.mjs --miniflare

# Existing migration/import/backup suites (now 8 migrations, format 4)
node --import ./scripts/sites-env.mjs tests/migration.test.mjs --miniflare
node --import ./scripts/sites-env.mjs tests/import-backup-direct.test.mjs --miniflare
node --import ./scripts/sites-env.mjs tests/backup.mjs --miniflare

# Scope matrix, tools/list snapshot, security matrix
node --experimental-strip-types --test tests/mcp-scope.test.mjs tests/tools-list-snapshot.mjs
node tests/security-matrix.mjs

# Full existing suite
pnpm run test:review
node --experimental-strip-types --test tests/auth-adapter.test.mjs tests/content-rules.test.mjs \
  tests/mcp-scope.test.mjs tests/tools-list-snapshot.mjs tests/route-guard.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint db/schema.ts lib/calibration.ts lib/analysis-isolation.ts lib/backup.ts \
  lib/backup-format.ts lib/coach.ts lib/mcp-scope.ts scripts/migrate/import-backup-direct.mjs \
  tests/calibration.test.mjs tests/calibration-backup.test.mjs
```

Observed results (2026-11-15, Node 24.15.0, Miniflare):

| Suite | Result |
| --- | --- |
| `tests/calibration.test.mjs` | 77 assertions, SQLite and Miniflare D1 (includes the real `callCoach` dispatch) |
| `tests/calibration-backup.test.mjs` | 26 assertions, SQLite and Miniflare D1/R2 |
| `tests/migration.test.mjs --miniflare` | 109 assertions |
| `tests/import-backup-direct.test.mjs --miniflare` | 125 assertions |
| `tests/backup.mjs --miniflare` | 52 assertions |
| `tests/mcp-scope.test.mjs` + `tools-list-snapshot.mjs` | 9 tests |
| `tests/security-matrix.mjs` | 8 tests |
| `tests/auth-adapter` + catalogue + pronunciation + speaking-draft + route-guard + content-rules | 47 tests (56-test group including the 9 above) |
| `pnpm run test:review` | 62 node tests + recording recovery + 2,484 state assertions + 4 codecs + 41 feedback + 77 review-task + 118 review-tool + 52 backup |
| `pnpm run test:pronunciation-coach` (concurrent UI workstream) | 14 + 9 tests |
| `pnpm exec tsc --noEmit` | clean |
| `pnpm exec eslint <changed files>` | clean |

Nothing was deployed and no wrangler command was run.
---

## Addendum (2026-11-16): catch trials, the constant-confirmer rule, and the two gates

The section above predates three changes. This addendum records the current
state; the earlier text is kept for traceability. **The closing line "Nothing
was deployed" is superseded** — the work below is deployed to production.

### Catch trials are now generated (they previously could not exist)

The detector only emits substitutions (`expected != actual`), so a control item
(`expected === actual`) could never appear naturally. Any gate requiring catch
trials was therefore unmeetable regardless of how much data accumulated.

`runner/grounded_audio.py::select_catch_trial` now emits a control on roughly a
third of recordings, chosen by a stable hash of the audio SHA so a re-run is
reproducible. The control word is taken from the detector's **unflagged**,
high-ASR-confidence words — never a flagged one, because a control on a genuinely
mispronounced word is confounded: the learner could correctly hear a real error
and confirm it, which would look like non-discrimination.

Controls carry an identical phone pair and `catchTrial: true`. They travel in the
`groundedAnalysis` payload **only**; `TierItem` and every rendered template stay
phone-free, so a control is indistinguishable in the confirmation UI. Server-side
they are issued as candidates (so the UI can reference them) but excluded from
`n_shown`, from category creation, and from every profile count.

### The constant-confirmer rule now has a consumer

`readCalibrationProfile` returns a `catchTrials` block with `shown`, `confirmed`,
`rejected`, `unsure`, `answered`, `confirmRate`, and `constantConfirmerFlag`.
Frozen thresholds are exported constants:

```
CATCH_TRIAL_MIN_ANSWERED      = 5
CATCH_TRIAL_CONFIRM_RATE_FLAG = 0.8
```

A listener who confirms most controls is not distinguishing errors, so their
verdicts carry no information. The flag is disclosed in the UI
(`ControlItemDisclosure`) **without ever naming which item was a control**, and
the V3 readiness pipeline excludes such listeners from adequacy. The flag does
**not** change promotion behaviour.

### Two gates, not one — and why

T2's actual claim is per-user ("your history suggests this class"). Gating that
behind a cross-user generalization requirement binds a technical capability to
user acquisition, which is a category error.

| Gate | Question | Requirement | A PASS permits |
| --- | --- | --- | --- |
| **V3-G** (`v3_gate.py`, unchanged) | Does the mechanism generalize across users? | >= 6 users | product-wide claims; T2 by default for new users |
| **V3-P** (`v3_personal_gate.py`) | Is **this user's** calibration reliable? | >= 2 history + >= 2 future sessions, >= 20 future candidates, human truth, catch trials, not a constant confirmer | T2 **for that user only**, per class |

V3-P **imports V3-G's constants and statistical helpers** (`T2_ABS_PRECISION`,
`T2_LB_FLOOR`, `TP_RETENTION_MIN`, `FROZEN_N`, `FROZEN_PROMOTE_POSTERIOR_LB`,
`wilson_lb`, `beta_ppf_10`), so no threshold can drift between them; tests assert
identity, including function-object identity.

Because candidates within one recording are correlated, the unit of replication
for a single user is the **session**, not the candidate. V3-P therefore adds
`multi_session_evidence` (>= 2 future sessions each contributing T2 candidates)
and `session_consistency` (at least half of those sessions meet their own
baseline). A test proves that a perfect pooled precision driven entirely by one
future session still **FAILS**.

Both gates are pre-registered before any real multi-session data existed.
**Neither is satisfied today**; T2 remains globally disabled and the product
remains T1 + T3. The remaining blockers are data, human annotation, and time —
not engineering.

### Transport defects found and fixed after the initial delivery

The calibration loop was initially **inert**: three independent breaks meant no
candidate could ever reach the learner. Existing tests only exercised rejection
paths, so all three survived.

1. The runner never sent `groundedAnalysis` (`ValidatedFeedback` had no analysis field).
2. `candidates_from_payload` dropped the detector's `expected`/`actual` pair.
3. The enriched analysis was passed only in `output` (hashed into the receipt),
   never persisted to `teacher_feedback.analysis_json` — on **both** the
   review-task path and the legacy v1 direct-insert path. Day 12 submissions are
   v1, so the legacy path was the one that mattered in production.

All three are fixed, with regression tests proven meaningful by reverting each
fix and observing the corresponding assertion fail.

### Current verification

| Suite | Result |
| --- | --- |
| Python runner | 207 |
| `tests/calibration.test.mjs` (SQLite and Miniflare D1) | 106 / 106 |
| `tests/feedback-api.mjs` | 56 |
| `tests/pronunciation-coach-ui.mjs` | 14 |
| `tests/pronunciation-review.test.mjs` | 21 |
| V3-P gate tests | 32 |
| Live isolated-QA end-to-end (incl. a real control item) | 14/14 |
| Production grounded contract | 8/8 |
