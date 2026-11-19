# Deployment

## Self-hosted Worker

Deploy via `scripts/own-deploy.mjs` merged over the vinext build output using `wrangler.own.jsonc`. All deployment-specific values are placeholders filled from CLI/env: worker name, custom domain, D1 database id/name, R2 bucket. `workers_dev`/`preview_urls` are disabled by default; access is through the pinned custom domain protected by Cloudflare Access.

**Build gotcha:** `pnpm run build` regenerates `dist/server/wrangler.json` and removes any private `wrangler.prod.json`; restore your private config before `wrangler deploy --config dist/server/wrangler.prod.json`.

## Authentication

Worker-level CF Access application; the adapter validates JWTs (aud) and service tokens. Unauthenticated requests receive a 302 to Access. Owner-only MCP tools additionally require owner scope.

## Migrations

Apply `drizzle/0000…0007` in order to the target D1. The `d1_migrations` bookkeeping must be consistent; migrations are not idempotent, so apply only pending ones.

## Observation windows

Each production change opens a 24h observation window evaluated by `analysis/scripts/observation/observation_window_eval.py` (launchd, every 30 min). Seven frozen criteria (full 24h, version unchanged, runner healthy, unauth 302, authenticated MCP read, no failed accumulation, safety config unchanged). A verdict is written only at/after the scheduled end; a window interrupted by a change is never claimed passed. The instrument is env-driven (`BANDROOM_SITE_URL`, `BANDROOM_WINDOW_CANONICAL`) and fail-closed; probes use a browser UA and never follow redirects, with transport-only retries.

## Rollback

Redeploy the previous Worker version with the matching private config; runner rollback via `coach_audio_mode="off"` / `self_listen_enabled=false`. Backups of runner config are kept outside the repo.
