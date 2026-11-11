# Bandroom acoustic analysis bundle

This package owns the part of the D2 pipeline that can be made reproducible
before a qualified acoustic model exists:

- decode the original browser file to a canonical 16 kHz mono sample timeline;
- record input SHA-256, byte count, container/decoded duration and codec;
- plan sample-exact chunks with overlap and complete-tail coverage;
- emit an `analysis.json` contract with an honest `blocked` state when no
  frozen model is configured;
- build and verify a private bundle for `get_analysis_bundle`.

It **does not** claim pronunciation accuracy. `UnavailableAnalyzer` returns
`blocked / qualified_analyzer_unavailable` and zero errors. A future model must
be added behind the `analyzer.py` contract and pass the sealed holdout gate
before any error reaches a learner.

## Local run

```sh
PYTHONPATH=analysis/src python3 -m bandroom_acoustic.cli \
  --audio /path/to/clip.wav \
  --out /tmp/analysis.json \
  --analysis-version bandroom-acoustic-dev
# exit 3 while blocked; inspect state/reason, never treat it as feedback
```

## Test

```sh
PYTHONPATH=analysis/src python3 -m unittest discover -s analysis/tests -v
```

## Build a bundle

```sh
python3 analysis/scripts/build_bundle.py --version bandroom-acoustic-0.1.0 \
  --out-dir analysis/bundle/bandroom-acoustic-0.1.0
python3 analysis/scripts/verify_bundle.py \
  --bundle analysis/bundle/bandroom-acoustic-0.1.0/bundle.tar.zst \
  --manifest analysis/bundle/bandroom-acoustic-0.1.0/manifest.json
```

Upload both files to private R2:

```text
analysis/<version>/bundle.tar.zst
analysis/<version>/manifest.json
```

Then configure `ANALYSIS_BUNDLE_VERSION`, `ANALYSIS_SIGNING_KEY` and
`BANDROOM_PUBLIC_ORIGIN` before `get_analysis_bundle` can issue a URL.

## Work recovery and release evidence

Use the isolated Sites app and consented test recordings. Run A claims a
speaking task and encounters a transient read failure. Retry the full transfer
with a bounded attempt count. If it still fails, call `fail_review_task` with
the observed error code and `retryable: true`. The server persists the next due
time. The next scheduled Work run must claim the same task with a new fence.

Ask the authenticated Work app for `get_review_transfer` with `taskId`,
`fence` and `action: "read_recording"`. Use the returned URL and method, with
the grant in the `Authorization` header. A private Site also requires its own
service access when the client uses direct HTTP. Send
`OAI-Sites-Authorization` only through the provisioned service connection.
Keep credentials and signed grants out of prompts, logs and evidence.
Compare the response byte count and SHA-256 with the returned input identity.
An expired transfer grant must be obtained again under the active lease.
Treat a short response as incomplete and retry from the source. A persistent
input identity mismatch needs investigation.

```sh
PYTHONPATH=analysis/src python3 -m bandroom_acoustic.cli \
  --audio "$bandroom_original" --input-sha256 "$bandroom_input_sha" \
  --analysis-version "$bandroom_analysis_version" \
  --decode-only --save-checkpoint "$bandroom_decode" --out "$bandroom_decode_summary"
```

Request `action: "save_decode"` with the file's `artifactSha256` and `bytes`.
Send the complete binary checkpoint with the returned PUT grant. The server
validates the original identity, analysis version, decoded manifest and PCM
payload before committing the task pointer. Wait for the successful receipt
before interrupting the run. The next lease can request
`action: "read_decode"` and GET the committed bytes.

```sh
PYTHONPATH=analysis/src python3 -m bandroom_acoustic.cli \
  --checkpoint "$bandroom_decode" --checkpoint-sha256 "$bandroom_decode_sha" \
  --input-sha256 "$bandroom_input_sha" \
  --analysis-version "$bandroom_analysis_version" --out "$bandroom_analysis"
```

The restore path checks the checkpoint and input digests and uses the stored
sample timeline. A speaking completion must consume that checkpoint under
its active fence and supply output from a qualified analyzer.

Close the browser and take the Mac offline between runs A and B. In B,
assemble the entire original and verify its length and SHA-256 before decode.
Save a decode checkpoint, then interrupt B. In C, claim the same task after
the lease expires and read the checkpoint with the current fence. Verify the
checkpoint and input digests before reuse. A checkpoint replay needs identical
artifact metadata and content. Complete the same attempt, exercise a lost
response, and read back the immutable receipt. Reopen the original question
after the offline interval and verify its feedback and playback timestamp.

Use Python 3.11 or later and OpenSSH with `ssh-keygen -Y` to check the sealed
Route A package from a clean candidate checkout.

```sh
python3 analysis/scripts/verify_release.py \
  --evidence ../delivery-d2/final \
  --trusted-signers /secure/bandroom-allowed-signers \
  --legacy-dir ../delivery-d2 \
  --recordings /secure/consented-holdout-originals
```

- `manifest.json` contains `schemaVersion: 2`, the full `sourceSha`,
  `buildSha256`, `analysisVersion`, `environmentId`, `route: "A"`, and
  `files`, a filename-to-SHA-256 map for the exact `FILES` set in the verifier.
  The build digest is the SHA-256 of `site-build.tar.gz`. Keep the evidence,
  original recordings, and all private signing keys outside Git.
- The release owner provisions four independent Ed25519 identities in an
  allowed-signers file outside the evidence directory. Each line contains
  the role principal, `ssh-ed25519`, and its public key blob. The release
  owner, holdout custodian, Work auditor and site auditor each inspect their
  original evidence and sign the exact same manifest bytes with namespace
  `bandroom-d2-release-v2`. Place each detached signature at `<role>.sig`.
  The signatures attest the provenance of original records, including the
  Work run history. Verify the operator and audit records before signing.
- Keep `--legacy-dir` on the trusted historical verification kit and use the
  original private files for its intake checks. Freeze the model weights and
  configuration, annotation rules, independent labels, adjudication and
  word slots before scoring. The verifier replays word alignment and scoring
  and derives coverage from completed inference windows. The intake
  inventory records `deviceClass` per clip. `stratified-score.json` records
  metrics, sample sizes, coverage and timing by device, encoding and condition
  using the same scorer as `score.json`.
- Preserve official Work history and isolated server events with run IDs,
  task ID, fences, transfer byte counts, checkpoint identity, retry time and
  receipt readback. In `offline.json`, use `beforeOfflineEvents` for A and
  `serverEvents` for B/C. Seal the actual committed `offline-checkpoint.bin`
  and the exact serialized `offline-output.json` from the receipt.
- In `offline-inference.json`, bind the run C windows to the task, committed
  checkpoint, model, configuration and output digest. For each window keep
  `chunkIndex`, `startSample`, `endSample`, `inputPcmSha256` and the
  `result` containing the exact result bytes and digest.
- In `browser-playback-events.json`, record Chrome and Safari reviews bound
  to the original attempt, receipt and independently verified error. Keep the
  actual media element `seeked`, `playing` and `pause` or `ended` events.
  Include distinct recordings of both encodings with first, middle and tail
  playback markers. Seal the separate human timing reference, platform probes,
  timestamped Mac connectivity checks and 24-hour schedule check against the
  same candidate.
- In `platform-probe.json`, bind `officialHistorySha256` to the Work export.
  Record `probes` for WebM/Opus and MP4/AAC, each at 30–45 seconds and
  165–180 seconds. Each row records original identity, the scheduled
  `readRun` that gave the verified original to the decoder, the scheduled
  `resumeRun` that verified the same committed checkpoint, and `faults` for
  truncation and expired access. Include run times and quota observations.
  `receiptProbe` records an isolated writing task completion and receipt
  readback on the same connection. This tests write authorization before
  the acoustic model is qualified.

The verifier exits 1 with `BLOCKED` when evidence is missing or inconsistent.
`READY` requires G0–G5 and the historical zero-added-cost guard. Keep local
test fixtures separate from that release package. The bundled analyzer still
reports `qualified_analyzer_unavailable` until a real candidate meets G2.

## Boundaries

- The bundle contains no learner audio, labels or signing keys.
- `analysis.json` is a measurement/contract, not a pronunciation verdict.
- The CLI exits 3 for blocked/failed results; callers must call
  `fail_review_task` with the exact reason, not fabricate feedback.
- `containerDurationMs` and `decodedDurationMs` are different measurements;
  a >5% difference is rejected for manual investigation.
