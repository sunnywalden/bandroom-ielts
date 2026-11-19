# Bandroom Wiki

Bandroom is an IELTS study studio with **grounded, honest coaching** for writing and speaking, built on Cloudflare Workers (D1 + R2) with a local Python coaching runner.

This wiki documents the public project: architecture, data model, the MCP tool surface, the pronunciation-calibration design, deployment, and testing.

## Contents

- [Architecture](Architecture) — Worker / runner / MCP / D1 / R2 / auth data flow.
- [Getting Started](Getting-Started) — local development, migrations, tests.
- [MCP Tools](MCP-Tools) — tool list and per-identity scope matrix.
- [Pronunciation Coaching](Pronunciation-Coaching) — three-tier honesty contract, calibration gates, catch-trials, profile UI.
- [Data Model](Data-Model) — tables, migrations 0000–0007, backup format 4.
- [Deployment](Deployment) — self-hosted Worker, Access, observation windows, rollback.
- [Testing](Testing) — regression suites and instrument self-checks.
- [Quality Gates](Quality-Gates) — G1–G5 definitions and current status.
- [Roadmap](Roadmap) — T2 evidence accumulation and independent G1/G5 projects.

## Principles

1. **Honesty over confidence.** The coach only asserts what it can measure; phoneme assertions stay off until per-category evidence gates pass.
2. **Per-user isolation.** Learner data lives in D1/R2, keyed by a stable `userId`; nothing is seeded from source.
3. **No personal data in the repo.** The foundation phase is synthetic sample data; credentials and operator identifiers are never committed.
