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

## Reproduce the spontaneous speech development probe

The probe trains small phoneme and boundary heads on a frozen DistilHuBERT
encoder. Whisper supplies word positions for the substitution, deletion and
insertion search. An offset acoustic pass checks the proposed events. The scorer
counts every reference error, including ones it cannot map to an ASR word.
These scripts run locally outside the Work analysis bundle. Use their output
for development diagnostics only.

Use the publisher's [L2-ARCTIC Suitcase archive](https://psi.engr.tamu.edu/l2-arctic-corpus/)
under its CC BY-NC 4.0 terms. The archive digest is pinned in
`development_probe.py`. The fixed development split trains on 17 speakers and
uses EBVS/SVBI for threshold calibration and HJK/LXC/RRBI for measurement.
All clips belong to the public corpus and are development material.

The measured setup used arm64 macOS, FFmpeg 4.4, Python 3.13.13, PyTorch
2.15.0, transformers 4.57.6, cmudict 1.1.3, NumPy 2.5.4, SciPy 1.18.1 and
safetensors 0.8.0. Supply a local directory containing `config.json` and
`model.safetensors` from the fixed
[DistilHuBERT revision](https://huggingface.co/ntu-spml/distilhubert/tree/fa87d96265d6b7af66e112faff6ff44df419cec9).
Build the [whisper.cpp v1.8.3 release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.3)
with CMake Release, `GGML_METAL=OFF`, `GGML_BLAS=OFF` and
`WHISPER_BUILD_TESTS=OFF`. Use `whisper-cli` and the pinned
[`ggml-base.en-q5_1.bin`](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en-q5_1.bin).

From the repository root, set `probe_python`, `archive`, `encoder`,
`whisper_bin`, `whisper_weights` and `ffmpeg` to local paths. Use a fresh
`run_root`. Generate predictions before opening evaluation labels.

```sh
mkdir -p "$run_root/audio"
"$probe_python" analysis/scripts/train_suitcase_probe.py \
  "$archive" "$encoder" "$run_root/probe" --ffmpeg "$ffmpeg"
for clip in ebvs svbi hjk lxc rrbi; do
  unzip -p "$archive" "suitcase_corpus/wav/$clip.wav" > "$run_root/audio/$clip.wav"
done
"$probe_python" analysis/scripts/run_development_probe.py \
  "$encoder" "$run_root/probe" "$whisper_bin" "$whisper_weights" \
  "$run_root/predictions" "$run_root/audio/"{ebvs,svbi,hjk,lxc,rrbi}.wav \
  --ffmpeg "$ffmpeg"
"$probe_python" analysis/scripts/evaluate_suitcase_probe.py \
  "$archive" "$run_root/predictions" "$run_root/probe/training.json" \
  "$run_root/development-score.json"
```

Keep the training manifest, weights, prediction files and score together
outside Git. Reuse the saved prediction files and manifest for score replay.
For local performance measurements, run one recording per fresh process
under `/usr/bin/time -l` on macOS. Record the decode, ASR and both acoustic
pass timings along with the process wall time. Work cold-start measurements
also need the full transfer, installation and concurrent memory costs.

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
`BANDROOM_PUBLIC_ORIGIN` before `get_analysis_bundle` can issue a URL. Acoustic
checkpoint transfer also requires `ANALYSIS_RUNTIME_BUNDLE_SHA256`, the exact
digest printed by `cloud_stage.py build`.

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

If direct HTTP is unavailable in the Work runner, read the original with the
authenticated recording tool. Request each range at the preceding
`nextOffset` and save each successful result as one JSON line in a private
temporary file. Stop at the verified total length. Assemble the original
before passing it to FFmpeg:

```sh
PYTHONPATH=analysis/src python3 -m bandroom_acoustic.work_transfer assemble-recording \
  --task-id "$bandroom_task" --recording-id "$bandroom_recording" \
  --input-sha256 "$bandroom_input_sha" --input-bytes "$bandroom_input_bytes" \
  --file "$bandroom_original" < "$bandroom_ranges"
```

For the isolated QA tool's response format, replace `--task-id` and
`--recording-id` with `--qa-job-id`. The assembler checks the task and
recording identity, sequence, each range length and the whole-file digest.
It replaces the output atomically after verification. Discard range files
when the input changes. If range reads still fail after bounded retries,
report the observed failure under the active lease.

For direct HTTP, `bandroom_acoustic.work_transfer download` and `upload`
accept the trusted envelope `{"grant": ..., "sitesAuthorization": ...}`
on standard input. Pass the exact `--origin`, input SHA-256, input byte
count and file. For checkpoint transfers also pass the analysis version,
artifact SHA-256, artifact byte count and, for acoustic windows, chunk
index. Pass credentials through private execution input and retain only
the sanitized result. If an upload reports `reconcile: true`, read the
stored pointer or receipt under the active lease before retrying the PUT.

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

### Acoustic checkpoint transfer

`bandroom_acoustic.acoustic_stage` runs the pinned development ONNX encoder
and phone head against the decoded PCM. Its receipt records the analysis
identity, next window, computed and reused window counts, and output hashes.
It requires NumPy, ONNX Runtime, and the two pinned graphs. This stage has no
authority to publish speaking feedback.

- Set `--max-new-chunks` to stop at a window boundary. With
  `--export-directory`, each numbered file `00.bin`, `01.bin`, and so on
  contains a canonical manifest and the actual float32 features. The
  corresponding `transferSha256` entries are artifact digests.
- Under the active lease, request `save_acoustic` with each file's
  `chunkIndex`, `artifactSha256` and `bytes`. PUT the bytes in index order
  and retain each successful checkpoint receipt. The site verifies the
  decoded input, pinned bundle, predecessor and window geometry. It advances
  the task pointer only when that checkpoint commits.
- Under the next lease, request `read_acoustic` for the committed prefix
  and verify its byte counts and SHA-256 digests. Pass the files in order
  as repeated `--restore-chunk SHA256=FILE` arguments to the runner with a
  fresh directory. Use the original attempt, revision, decoded artifact and
  runtime configuration. Resume at the first absent window. On transient
  read failure, obtain a fresh grant under the current lease or persist
  `retry_wait` before the lease expires.

### Cloud runtime bundle

`analysis/scripts/cloud_stage.py` builds a self-contained Linux x86-64 bundle
for a Work executor that has no network access to PyPI. Place the two pinned
graphs (`encoder-int8.onnx`, `probe-head.onnx`) and the wheels named in
`requirements-cloud-x86_64.txt` in private directories, then build:

```sh
python3 analysis/scripts/cloud_stage.py build \
  --bundle /secure/bandroom-runtime/acoustic-stage.zip \
  --graphs /secure/bandroom-graphs \
  --wheels /secure/bandroom-wheels
```

The builder verifies every graph and wheel digest, includes all
`src/bandroom_acoustic` modules plus the lock file, and prints the bundle
SHA-256. The archive contains no learner audio, labels or keys. Run stages on
Linux x86-64 CPython 3.12 with FFmpeg on `PATH`:

```sh
python3 analysis/scripts/cloud_stage.py decode \
  --bundle /secure/bandroom-runtime/acoustic-stage.zip --bundle-sha256 "$bundle_sha" \
  --input-sha256 "$input_sha" --analysis-version "$analysis_version" \
  --audio "$original" --input-bytes "$input_bytes" --save-checkpoint "$decode"

python3 analysis/scripts/cloud_stage.py acoustic \
  --bundle /secure/bandroom-runtime/acoustic-stage.zip --bundle-sha256 "$bundle_sha" \
  --input-sha256 "$input_sha" --analysis-version "$analysis_version" \
  --checkpoint "$decode" --checkpoint-sha256 "$decode_sha" \
  --directory "$acoustic_work" --environment "$environment" --task "$task" \
  --attempt "$attempt" --revision "$revision" \
  --max-new-chunks 4 --export-directory "$transfer"
```

The acoustic stage installs the pinned wheels offline and refuses a foreign
platform, bundle digest, graph digest or checkpoint identity. The exported
`NN.bin` files and the receipt's `transferSha256` list are the exact artifacts
to submit through `save_acoustic`. This bundle contains the development probe
head, not a qualified analyzer, so it must not produce learner feedback.

Configure the site with `ANALYSIS_RUNTIME_BUNDLE_SHA256` set to the exact
SHA-256 printed by `cloud_stage.py build`. The first `save_acoustic` grant for a
task binds that digest, and the site rejects a chunk whose `bundleSha256`
differs with `invalid_acoustic_checkpoint`. Later chunks must reuse the
committed predecessor's digest, so a resumed run must use the same runtime zip.
The digest must also equal the runner's `--bundle-sha256` and the signed
`runtimeBundleSha256`. The analysis bundle served by `get_analysis_bundle` is a
separate artifact; its `manifest.json` digest is not the runtime binding and
must not be used for `save_acoustic`.

The following procedure applies to the historical Route A release protocol.
Obtain the Mac owner's explicit authorization before disconnecting the host.

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

### Scheduled Work recovery release

Use the scheduled Work verifier for the protocol that tests recovery while the
original exercise is closed.

```sh
PYTHONPATH=analysis/src python3 analysis/scripts/verify_cloud_release.py \
  --evidence /secure/bandroom-cloud-evidence \
  --trusted-signers /secure/bandroom-allowed-signers \
  --legacy-dir /secure/trusted-delivery-d2 \
  --recordings /secure/consented-holdout-originals \
  --repo . --phase candidate
```

- Sign the exact `manifest.json` bytes with the four release roles in the
  `bandroom-d2-cloud-recovery-v1` namespace. Use schema version 1 with the
  protocol, base commit, candidate tree, site build, runtime archive, weights,
  configuration and file digests. Keep the keys and original evidence outside
  the repository. The candidate phase compares the signed tree to the staged
  candidate. The release phase checks the clean committed tree after merge.
- Seal the official Work history, isolated site events and executor receipts.
  Correlate the failed read, prefix save and resumed write to the same
  recording, attempt and scheduled task with distinct runs and increasing
  fences. Record the committed chunks, the read-only cold output, and the
  original receipt readback after a lost response. Preserve the three empty
  queue wakes over 24 hours and the queue fairness check.
- Seal the dual-annotated and adjudicated holdout, scoring and inference ledger,
  the two browser codec probes and cold profiles, and the Chrome media events
  from the original answer. Attest zero added cost and record rollback and
  unchanged learner state using the isolated acceptance site.

The verifier exits 1 with `BLOCKED` if any of these checks fail. Run receipts
from a local Linux probe and temporary signing keys belong in development
tests. Release auditors sign only after inspecting the official records.

## Boundaries

- The bundle contains no learner audio, labels or signing keys.
- `analysis.json` is a measurement/contract, not a pronunciation verdict.
- The CLI exits 3 for blocked/failed results; callers must call
  `fail_review_task` with the exact reason, not fabricate feedback.
- `containerDurationMs` and `decodedDurationMs` are different measurements;
  a >5% difference is rejected for manual investigation.
