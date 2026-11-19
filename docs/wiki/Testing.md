# Testing

## Node / Miniflare suites

- `test:review` — state API (2484 assertions, real SQLite + app routes), review-tasks (77), review-tools (118), feedback-api (56), coach-audio (63), recording-recovery (isolated R2), backup (52, Miniflare D1+R2).
- `test:pronunciation-coach` — pronunciation-review logic + mounted UI (jsdom/esbuild, real client → real `/mcp` route) + client-route regression.
- `test:pronunciation` — display/review logic.
- `tests/migration.test.mjs` — 109 migration assertions (SQLite + isolated R2 adapter).
- `tests/public-release-guard.mjs` — asserts tracked source carries no personal identity/paths/URL/real seeded records; foundation labelled synthetic; identity session-driven.
- Scope/security: `mcp-scope`, `route-guard`, `security-matrix`, `auth-adapter`.

## Python

- `pytest runner/tests` — runner orchestrator, models, prosody, pause calibration, catch-trials, tier gate, heartbeat, content rules, calibration transport.
- `analysis/scripts/calibration-gates/` — V3-G / V3-P / data-pipeline tests (threshold identity asserted).
- `analysis/scripts/observation/test_observation_eval.py` — instrument self-checks incl. fail-closed on missing site URL.

## Lessons encoded as tests

- Instruments must self-check against a known-good state (CF UA block, redirect-following) before deciding long windows.
- Success paths must be tested end-to-end, not only rejection paths (a fully-inert feature once passed acceptance).
- Regression tests are proven effective by reverting the fix and watching them go red.
