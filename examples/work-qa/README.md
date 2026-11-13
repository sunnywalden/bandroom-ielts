# Bandroom Work QA connector

This worker exercises the Work review and acoustic checkpoint protocols against isolated QA data. It uses D1 for job, lease and checkpoint metadata and R2 for recording and checkpoint bytes. The fixture transport path runs only when the QA environment sets `QA_TRANSPORT_FIXTURE_JOB_ID`.

The bundled fixtures contain synthetic prompts and public NASA Crew-6 interview excerpts. They support transport and recovery tests. See the source note in the interview fixture modules for attribution.

From the repository root, install dependencies with `pnpm install --frozen-lockfile`, then run:

```sh
node examples/work-qa/tests/qa-acoustic-checkpoints.test.mjs .
node examples/work-qa/tests/qa-hosted-retry.test.mjs .
node examples/work-qa/tests/qa-audio-processing.test.mjs .
```

The audio-processing test requires FFmpeg on PATH or a binary specified by `FFMPEG_BIN`. The tests use local Miniflare databases and buckets. Cloud Work recovery and pronunciation accuracy on independently annotated free speech require separate acceptance tests.
