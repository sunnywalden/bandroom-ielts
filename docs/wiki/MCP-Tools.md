# MCP Tools

The Worker exposes a JSON-RPC MCP surface at `/mcp` (protocol `2026-07-28`). Every tool is registered in a per-identity **scope matrix** (`lib/mcp-scope.ts`); owner-only tools reject runner/service identities, and no tool accepts a client-supplied `userId` (identity is derived server-side).

## Tool surface

| Tool | Purpose |
|------|---------|
| `ping` | liveness |
| `read_study_session` | read learner state/day |
| `add_coach_feedback` | runner writes coaching feedback |
| `publish_lesson` | coach-authored adaptive lesson packs |
| `claim_review_tasks` / `renew_review_lease` / `fail_review_task` | runner job lifecycle |
| `complete_review_task` | finalize feedback; persists `analysis_json`, issues `candidateId`s |
| `read_review_recording` / `read_speaking_recording` / `read_recording_bytes` | scoped audio access |
| `save_review_checkpoint` / `read_review_checkpoint` | cross-run durability |
| `read_review_receipt` / `get_review_transfer` | receipts / transfer |
| `get_analysis_bundle` | frozen acoustic bundle (manifest + model hashes) |
| `report_scheduler_heartbeat` | runner health |
| `read_pronunciation_profile` | per-class confirmation/rejection/unsure counts + progress |
| `record_pronunciation_verdict` | three-state self-listen verdict (owner-only) |
| `reset_pronunciation_profile` | clear calibration (owner-only; keeps recordings/backups) |

## Scope design

- **Owner** (human session): profile read/verdict/reset, study state.
- **Runner/service**: claim/complete/heartbeat/audio reads; **cannot** record human verdicts.
- Guards live in `lib/route-guard.ts` + `lib/mcp-scope.ts`; regression in `tests/mcp-scope.test.mjs`, `tests/route-guard.test.mjs`, `tests/security-matrix.mjs`.

## Catch-trial indistinguishability

Server-issued catch trials (`expected === actual`) render identically to real candidates in the UI; phone pairs are never rendered (that would expose them). They are excluded from per-class progress and used only for constant-confirmer detection.
