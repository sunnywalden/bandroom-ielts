# Getting Started

## Prerequisites

- Node.js `>=22.13.0`, `pnpm`
- Python 3.12 (coaching runner), FFmpeg (audio regression tests)
- Wrangler/Miniflare come from project dev-dependencies.

## Install & run

```sh
pnpm install
pnpm run dev        # Vite/vinext dev server, simulated D1/R2 bindings (loopback)
pnpm run build      # produces dist/server/wrangler.json + client assets
pnpm start          # preview built Worker locally via Wrangler + Miniflare
```

Local development identity is simulated on loopback only and is **not** included in production builds. Production identity comes from Cloudflare Access.

## Local D1 migrations

```sh
pnpm run db:generate   # after editing db/schema.ts
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js \
  d1 execute DB --local --config dist/server/wrangler.json \
  --persist-to .wrangler/state --file drizzle/0000_left_logan.sql
```

Apply pending migrations in order; do not replay already-applied ones.

## Configuration & secrets

No credentials are committed. Provide deployment values via environment/CLI:
- `wrangler.own.jsonc` — placeholders (`${WORKER_NAME}`, `${BANDROOM_DOMAIN}`, `${D1_DATABASE_ID}`, …) filled by `scripts/own-deploy.mjs`.
- `runner/config.example.toml` — runner configuration template; real config (API keys, client ids) stays in private files.

## Tests

See [Testing](Testing). Quick smoke:

```sh
pnpm run test:pronunciation-coach
node --experimental-strip-types --test tests/catalogue.test.mjs tests/public-release-guard.mjs
```
