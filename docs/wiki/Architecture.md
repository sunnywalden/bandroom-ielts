# Architecture

## Components

- **UI** — Next.js-on-vinext client components under `app/` (studio, speaking, exercise, reports, pronunciation coach/profile, backup panel).
- **Worker** — `worker/index.ts` entry; routes under `app/api/*` and the MCP endpoint `app/mcp/route.ts`. Owns D1 (state, feedback, review tasks, calibration) and R2 (recordings, backups, analysis bundles).
- **Auth adapter** — `lib/auth-adapter.ts` maps Cloudflare Access JWTs and service tokens to `{userId, displayName, email, scope}`. Owner-only tools are guarded separately from runner/service scopes.
- **Coaching runner** — local Python process (`runner/`) that claims review jobs over MCP, calls DashScope (Qwen text + omni audio), and writes feedback back. Model calls happen **before** claiming a lease so a slow model never holds a lease.
- **Analysis tooling** — `analysis/` holds acoustic/prosody/calibration/observation scripts (no audio or weights committed).

## Request / data flow

1. Browser authenticates via CF Access; the Worker derives `userId` + scope.
2. UI reads/writes state via `/api/state` (optimistic concurrency with revisions) and reads feedback/profile via MCP.
3. Speaking submissions store audio in R2 and create review tasks in D1.
4. The runner claims tasks (`claim_review_tasks`), decodes audio, runs grounded prosody + model coaching, and completes via `complete_review_task` (which persists `analysis_json` and issues `candidateId`s).
5. The profile UI reads `read_pronunciation_profile` and records three-state verdicts via `record_pronunciation_verdict`.

## Isolation & safety

- Per-user rows keyed by `userId`; route guards (`lib/route-guard.ts`, `lib/mcp-scope.ts`) enforce scope per tool.
- Service identities cannot forge human confirmations (owner-only verdict tools reject runner scope).
- Backups are signed and bound to the original site + account; restore verifies before writing.
