# Bandroom — IELTS Study Studio

A full-stack IELTS learning journal with **grounded, honest coaching** for writing and speaking, running entirely on Cloudflare Workers (D1 + R2) with a local coaching runner.

Bandroom pairs a structured 62-lesson study programme (daily practice, learning archive, correction notebook, progress review) with a coach that only claims what it can actually measure. Its pronunciation profile is built around a three-tier honesty contract rather than over-confident error assertions.

> Status: public project. The seeded "foundation phase" (Day 1–11) in `app/ledger.ts` is **synthetic sample data** for demonstration and regression only — never a real learner's record. Real progress lives in D1.

## Features

- **Today's practice / learning archive / correction notebook / progress review** — a day-by-day IELTS programme with independent first drafts, revisions, and spaced vocabulary recall.
- **Writing & speaking coach** — rubric-based feedback delivered through MCP tools; speaking feedback is grounded in calibrated prosody (pause/duration) with second-level timestamps.
- **Personal pronunciation profile** — three-tier contract:
  - **T1** calibrated, measurable prosody (assertions allowed);
  - **T2** historically-confirmed personal categories (suggestions, gated by evidence);
  - **T3** uncalibrated suggestions (self-listen contrast, never asserted as errors).
- **Honest calibration** — phoneme assertions are globally OFF until per-category evidence gates pass; catch-trials and constant-confirmer detection keep the calibration signal discriminating.
- **Signed backup & restore** (format 4), recording recovery, and per-user isolation.

## Architecture

```
Browser (Next.js / vinext UI)
   │  CF Access (JWT) / service tokens
   ▼
Cloudflare Worker ── D1 (SQLite) + R2 (recordings/backups)
   │  MCP (JSON-RPC over /mcp, scoped tools)
   ▼
Local coaching runner (Python) ── DashScope (Qwen text + omni audio)
```

- The Worker owns state, recordings, review tasks, and the MCP tool surface with a per-identity scope matrix.
- A local runner claims review jobs, calls the model, and writes feedback back through MCP; it never holds a lease across model calls.
- Authentication is via Cloudflare Access; the adapter maps JWT/service identities to a stable `userId` and scope.

See the [Wiki](../../wiki) for architecture, data model, MCP tools, calibration design, deployment, and testing.

## Quick start

Prerequisites: Node.js `>=22.13.0`, `pnpm`, Python 3.12 (runner), FFmpeg (audio tests).

```sh
pnpm install
pnpm run dev          # Vite/vinext dev server with simulated D1/R2 bindings
pnpm run db:generate  # after schema changes
pnpm run build        # deployable Worker artifact
pnpm start            # preview the built Worker locally (Wrangler + Miniflare)
```

Local identity for development is simulated on loopback only; production identity comes from Cloudflare Access. **No credentials are committed** — supply them via environment / private config (see `runner/config.example.toml` and `wrangler.own.jsonc`).

## Testing

```sh
pnpm run test:review             # state API (2484 assertions), review tasks/tools, backup, recovery, coach
pnpm run test:pronunciation-coach# calibration UI + real-route client tests
pnpm run test:pronunciation      # pronunciation display/review logic
node --import ./scripts/sites-env.mjs tests/migration.test.mjs   # 109 migration assertions
pytest runner/tests              # runner suite
python3 analysis/scripts/observation/test_observation_eval.py    # observation instrument
```

A public-facing engineering quality record is served at [`/engineering-review.html`](public/engineering-review.html).

## Deployment

Self-hosted via `scripts/own-deploy.mjs` + `wrangler.own.jsonc` (custom domain, Workers Access). All deployment-specific values (worker name, domain, D1/R2 IDs) are injected from environment/CLI — nothing personal is committed. After `pnpm run build`, restore your private `dist/server/wrangler.prod.json` before deploying.

## Project layout

| Path | Purpose |
|------|---------|
| `app/` | UI routes, components, MCP route, state transitions |
| `lib/` | auth adapter, calibration, coach, review tasks/tools, backup, scope guards |
| `db/`, `drizzle/` | schema + migrations 0000–0007 |
| `worker/` | production Worker entrypoint |
| `runner/` | local Python coaching runner + prompts + tests |
| `analysis/` | acoustic/calibration/observation tooling (scripts only; no audio/weights) |
| `tests/` | Node/Miniflare regression suites |
| `examples/work-qa/` | isolated QA server + acceptance tooling |

## License & third-party

Code licensed under the MIT License (see `LICENSE`). Vendored components retain their own licenses (`vendor/`, `scripts/vite/`). `analysis/` scripts reference external corpora (e.g. L2-ARCTIC, CC BY-NC) but **no audio or model weights are distributed** in this repository.

## Privacy

Per-user data is isolated in D1/R2 and never seeded from source. The repository contains no personal learner records, credentials, or operator identifiers.
