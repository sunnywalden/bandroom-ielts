#!/usr/bin/env python3
"""R2 proof: verify the exporter's verifier-plan implementation against the real code.

Runs locally, never touches the network or the QA server.

1. Compares export_g5_evidence.plan_windows() with the real
   bandroom_acoustic.acoustic_stage.windows() for the HJK sample count and a
   small synthetic count.
2. Builds a minimal signed-evidence-shaped directory (checkpoint, two transfer
   chunks, runtime-bundle.zip, offline-output pair, manifest, recovery, events,
   executor receipts) and calls the real
   verify_cloud_release.verify_acoustic().
3. Mutates one chunk and one executor list and asserts the verifier rejects.

Exit 0 = all checks pass. Temporary directories are removed.
"""

from __future__ import annotations

import importlib.util
import json
import math
import shutil
import struct
import sys
import tempfile
import zipfile
from hashlib import sha256
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = next(parent for parent in HERE.parents
            if (parent / ".sites-checkout/analysis/scripts/verify_cloud_release.py").is_file())
SCRIPTS = REPO / ".sites-checkout/analysis/scripts"
SRC = REPO / ".sites-checkout/analysis/src"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SRC))

from bandroom_acoustic.acoustic_stage import windows  # noqa: E402
import verify_cloud_release as cloud  # noqa: E402

spec = importlib.util.spec_from_file_location("g5", HERE / "export_g5_evidence.py")
g5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g5)

RECORDING = "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1"
ANALYSIS_VERSION = "v26-test"
FAILURES = 0


def check(condition: bool, message: str) -> None:
    global FAILURES
    if condition:
        print(f"PASS  {message}")
    else:
        FAILURES += 1
        print(f"FAIL  {message}")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha(value: bytes) -> str:
    return sha256(value).hexdigest()


def plan_equivalence() -> None:
    for sample_count in (1_099_196, 100_000):
        real = [
            {"offset": row.offset, "start_frame": row.start_frame, "end_frame": row.end_frame,
             "left_context": row.left_context, "right_context": row.right_context}
            for row in windows(sample_count)
        ]
        mine = g5.plan_windows(sample_count)
        check(real == mine, f"plan matches acoustic_stage.windows for {sample_count} samples")
    check(len(g5.plan_windows(1_099_196)) == 10, "HJK plan has 10 chunks")


def write_checkpoint(path: Path, sample_count: int, input_bytes: int = 441_322) -> str:
    pcm = bytes((index * 7) % 256 for index in range(2 * sample_count))
    manifest = {
        "format": "bandroom-decode-v1",
        "analysisVersion": ANALYSIS_VERSION,
        "inputSha256": RECORDING,
        "inputBytes": input_bytes,
        "container": "mp4",
        "codec": "aac",
        "sourceRateHz": 48_000,
        "sourceChannels": 1,
        "containerDurationMs": 6_250.0,
        "primingMs": 0.0,
        "pcm": {"encoding": "s16le", "rateHz": 16_000, "channels": 1,
                "sampleCount": sample_count, "sha256": sha(pcm)},
        "mediaTime": {"originMs": 0, "samplesPerSecond": 16_000},
    }
    body = canonical(manifest)
    value = struct.pack(">I", len(body)) + body + pcm
    path.write_bytes(value)
    return sha(value)


def build_fixture(root: Path) -> dict:
    bundle = root / "evidence"
    bundle.mkdir()
    sample_count = 100_000
    checkpoint_sha = write_checkpoint(bundle / "offline-checkpoint.bin", sample_count)

    encoder = b"test-encoder-graph"
    head = b"test-head-graph"
    stage = {
        "analysisVersion": ANALYSIS_VERSION,
        "format": "bandroom-acoustic-features-v1",
        "encoderSha256": sha(encoder),
        "headSha256": sha(head),
        "frameSamples": 320,
        "receptiveSamples": 400,
        "windowFrames": 800,
        "contextFrames": 100,
        "offsets": [0, 400],
        "featureCount": 768,
        "phoneCount": 49,
        "runtime": {"onnxruntime": "1.24.4", "numpy": "2.4.4", "threads": 2,
                    "provider": "CPUExecutionProvider", "machine": "x86_64", "system": "Linux"},
    }
    identity = {
        "environment": "qa",
        "taskId": "Automation_test",
        "attemptId": "qa-speech-01",
        "revision": 1,
        "inputSha256": RECORDING,
        "inputBytes": 441_322,
        "decodeSha256": checkpoint_sha,
        "bundleSha256": None,  # filled after the zip is written
        "configSha256": sha(canonical(stage)),
    }

    runtime = bundle / "runtime-bundle.zip"
    with zipfile.ZipFile(runtime, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("cloud-stage.json", json.dumps(
            {"files": {"graphs/encoder-int8.onnx": stage["encoderSha256"],
                       "graphs/probe-head.onnx": stage["headSha256"]}}, sort_keys=True))
        archive.writestr("graphs/encoder-int8.onnx", encoder)
        archive.writestr("graphs/probe-head.onnx", head)
    runtime_sha = sha(runtime.read_bytes())
    identity["bundleSha256"] = runtime_sha

    plan = g5.plan_windows(sample_count)
    previous = checkpoint_sha
    chunks = []
    raw_chunks = []
    digests = []
    for index, window in enumerate(plan):
        raw = bytes([index + 1]) * g5.window_bytes(window)
        blob = g5.encode_transfer_chunk(identity, index, previous, raw)
        (bundle / f"acoustic-{index:02}.bin").write_bytes(blob)
        digest = sha(blob)
        chunks.append({"sha256": digest, "bytes": len(raw)})          # transfer digests
        raw_chunks.append({"sha256": sha(raw), "bytes": len(raw)})   # AcousticStore metadata
        digests.append(digest)
        previous = digest
    check(len(plan) == 2, "fixture has two plan chunks (small sample count)")

    cut = 1
    prefix_manifest = g5.acoustic_manifest(identity, plan, raw_chunks[:cut])
    all_manifest = g5.acoustic_manifest(identity, plan, raw_chunks)
    logits = [
        {"offset": offset,
         "frames": sum(row["end_frame"] - row["start_frame"] for row in plan if row["offset"] == offset),
         "frameSha256": "1" * 64, "ctcSha256": "2" * 64, "boundarySha256": "3" * 64}
        for offset in (0, 400)
    ]

    output = b"completed-output"
    (bundle / "offline-output.json").write_bytes(output)
    (bundle / "offline-cold-output.json").write_bytes(output)
    output_sha = sha(output)

    manifest = {
        "schemaVersion": 1,
        "protocol": "bandroom-d2-cloud-recovery-v1",
        "route": "A",
        "analysisVersion": ANALYSIS_VERSION,
        "environmentId": "qa",
        "runtimeBundleSha256": runtime_sha,
        "files": {
            "offline-checkpoint.bin": checkpoint_sha,
            "offline-output.json": output_sha,
            "offline-cold-output.json": output_sha,
            **{f"acoustic-{index:02}.bin": digest for index, digest in enumerate(digests)},
        },
    }
    offline = {
        "jobId": "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710",
        "taskId": identity["taskId"],
        "attemptId": identity["attemptId"],
        "attemptRevision": 1,
        "recordingId": "recording-1",
        "recordingSha256": RECORDING,
        "inputBytes": 441_322,
        "analysisVersion": ANALYSIS_VERSION,
        "environmentId": "qa",
        "isolated": True,
        "runs": [],
    }
    recovery = {
        "identity": identity,
        "prefix": digests[:cut],
        "resumed": digests,
        "cold": digests,
        "coldRunId": "cold-run",
        "coldStageIndexSha256": sha(all_manifest),
        "coldLogits": logits,
    }
    config = {"acousticConfig": stage}
    b_event = {"checkpoint_saved": {"nextChunk": cut, "checkpointSha256": digests[cut - 1]}}
    c_event = {"checkpoint_restored": {"nextChunk": cut, "checkpointSha256": digests[cut - 1]},
               "suffix_completed": {"chunks": digests[cut:]}}
    workers = [
        {"officialRunId": "run-b", "executionId": "e1", "source": "cloud-executor", "localExecution": False,
         "readBytes": 441_322, "computedSha256": RECORDING, "decoderInputSha256": RECORDING,
         "savedChunks": digests[:cut], "stageIndexSha256": sha(prefix_manifest)},
        {"officialRunId": "run-c", "executionId": "e2", "source": "cloud-executor", "localExecution": False,
         "readBytes": 441_322, "decoderInputSha256": RECORDING,
         "restoredChunks": digests[:cut], "newChunks": digests[cut:],
         "stageIndexSha256": sha(all_manifest), "logits": logits, "outputSha256": output_sha},
        {"officialRunId": "cold-run", "executionId": "e3", "source": "cloud-executor", "localExecution": False,
         "readOnly": True, "cacheEmpty": True, "restoredChunks": [], "newChunks": digests,
         "readBytes": 441_322, "decoderInputSha256": RECORDING,
         "stageIndexSha256": sha(all_manifest), "logits": logits, "outputSha256": output_sha},
    ]
    return {"bundle": bundle, "manifest": manifest, "offline": offline, "recovery": recovery,
            "config": config, "b": b_event, "c": c_event, "workers": workers}


def expect_ok(fixture: dict, label: str) -> None:
    try:
        cloud.verify_acoustic(fixture["bundle"], fixture["manifest"], fixture["offline"],
                              fixture["recovery"], fixture["config"], fixture["b"], fixture["c"],
                              fixture["workers"])
        check(True, f"verify_acoustic accepts {label}")
    except Exception as error:  # noqa: BLE001 - report the real verifier error
        check(False, f"verify_acoustic accepts {label}: {type(error).__name__}: {error}")


def expect_reject(fixture: dict, label: str, mutate) -> None:
    import copy
    broken = copy.deepcopy(fixture)
    mutate(broken)
    try:
        cloud.verify_acoustic(broken["bundle"], broken["manifest"], broken["offline"],
                              broken["recovery"], broken["config"], broken["b"], broken["c"],
                              broken["workers"])
        check(False, f"verify_acoustic rejects {label}")
    except ValueError:
        check(True, f"verify_acoustic rejects {label}")


def integration() -> None:
    root = Path(tempfile.mkdtemp(prefix="r2-acoustic-"))
    try:
        fixture = build_fixture(root)
        expect_ok(fixture, "synthetic prefix/resume/cold evidence")

        def corrupt_chunk(target: dict) -> None:
            path = target["bundle"] / "acoustic-01.bin"
            value = bytearray(path.read_bytes())
            value[-1] ^= 0xFF
            path.write_bytes(bytes(value))

        expect_reject(fixture, "a corrupted acoustic chunk", corrupt_chunk)

        def wrong_suffix(target: dict) -> None:
            target["workers"][1]["newChunks"] = list(reversed(target["recovery"]["resumed"][1:]))

        expect_reject(fixture, "executor suffix that differs from resumed", wrong_suffix)

        def wrong_stage(target: dict) -> None:
            target["workers"][0]["stageIndexSha256"] = "0" * 64

        expect_reject(fixture, "a prefix stage index that does not reproduce", wrong_stage)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def export_pipeline() -> None:
    """Build a full evidence bundle with export_g5_evidence and verify it."""
    root = Path(tempfile.mkdtemp(prefix="r2-export-"))
    try:
        run = root / "run"
        out = root / "out"
        static = run / "static"
        for directory in ("runs", "official", "site", "executor", "acoustic",
                          "browser", "platform", "release", "static"):
            (run / directory).mkdir(parents=True)
        identity = {
            "sourceSha": "a" * 40, "sourceTreeSha": "b" * 40, "analysisVersion": ANALYSIS_VERSION,
            "environmentId": "qa", "route": "A",
        }
        encoder = b"pipeline-encoder"
        head = b"pipeline-head"
        stage = {
            "analysisVersion": ANALYSIS_VERSION, "format": "bandroom-acoustic-features-v1",
            "encoderSha256": sha(encoder), "headSha256": sha(head),
            "frameSamples": 320, "receptiveSamples": 400, "windowFrames": 800,
            "contextFrames": 100, "offsets": [0, 400], "featureCount": 768, "phoneCount": 49,
            "runtime": {"onnxruntime": "1.24.4"},
        }
        (static / "analysis-config.json").write_text(json.dumps({"acousticConfig": stage}))
        for name, value in {
            "site-build.tar.gz": b"site", "analysis-bundle.tar.zst": b"bundle",
            "model-weights.bin": b"weights", "preflight.json": b"{}", "score.json": b"{}",
            "stratified-score.json": b"{}", "holdout-inventory.json": b"{}",
            "annotator-a.json": b"{}", "annotator-b.json": b"{}", "adjudicated.json": b"{}",
            "predictions.json": b"{}", "aligned-predictions.json": b"{}", "word-map.json": b"{}",
            "reference-words.json": b"{}", "holdout-ledger.json": b"{}",
            "inference-windows.json": b"{}",
        }.items():
            (static / name).write_bytes(value)

        runtime = run / "release" / "runtime-bundle.zip"
        with zipfile.ZipFile(runtime, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("cloud-stage.json", json.dumps(
                {"files": {"graphs/encoder-int8.onnx": stage["encoderSha256"],
                           "graphs/probe-head.onnx": stage["headSha256"]}}, sort_keys=True))
            archive.writestr("graphs/encoder-int8.onnx", encoder)
            archive.writestr("graphs/probe-head.onnx", head)
        (run / "release" / "gates.json").write_text(json.dumps(
            {"releaseEligible": True, "gates": {f"G{i}": {"status": "passed"} for i in range(6)}}))
        (run / "release" / "zero-cost.json").write_text("{}")

        def digest(path: Path) -> str:
            return sha(path.read_bytes())

        identity.update(
            buildSha256=digest(static / "site-build.tar.gz"),
            runtimeBundleSha256=digest(runtime),
            modelWeightsSha256=digest(static / "model-weights.bin"),
            configSha256=digest(static / "analysis-config.json"),
        )
        (run / "identity.json").write_text(json.dumps(identity))

        sample_count = 100_000
        checkpoint_sha = write_checkpoint(run / "acoustic" / "offline-checkpoint.bin", sample_count)
        expected_identity = {
            "environment": "qa", "taskId": "Automation_pipeline", "attemptId": "qa-speech-01",
            "revision": 1, "inputSha256": RECORDING, "inputBytes": 441_322,
            "decodeSha256": checkpoint_sha, "bundleSha256": identity["runtimeBundleSha256"],
            "configSha256": sha(canonical(stage)),
        }
        plan = g5.plan_windows(sample_count)
        previous = checkpoint_sha
        transfer = []
        raw_chunks = []
        for index, window in enumerate(plan):
            raw = bytes([index + 1]) * g5.window_bytes(window)
            blob = g5.encode_transfer_chunk(expected_identity, index, previous, raw)
            (run / "acoustic" / f"acoustic-{index:02}.bin").write_bytes(blob)
            transfer.append(sha(blob))
            raw_chunks.append({"sha256": sha(raw), "bytes": len(raw)})
            previous = sha(blob)
        cut = 1
        logits = [
            {"offset": offset,
             "frames": sum(row["end_frame"] - row["start_frame"] for row in plan if row["offset"] == offset),
             "frameSha256": "1" * 64, "ctcSha256": "2" * 64, "boundarySha256": "3" * 64}
            for offset in (0, 400)
        ]
        plan_doc = {
            "sampleCount": sample_count, "identity": expected_identity, "plan": plan,
            "cut": cut, "prefix": transfer[:cut], "resumed": transfer, "cold": transfer,
            "coldRunId": "cold-run", "coldLogits": logits,
            "coldStageIndexSha256": sha(g5.acoustic_manifest(expected_identity, plan, raw_chunks)),
        }
        (run / "acoustic" / "plan.json").write_text(json.dumps(plan_doc))
        (run / "acoustic" / "checkpoint-7.json").write_bytes(b"{}")
        (run / "acoustic" / "cold-output.json").write_bytes(b"{}")
        output_sha = sha(b"{}")

        common = {
            "jobId": "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710",
            "taskId": "Automation_pipeline", "attemptId": "qa-speech-01", "attemptRevision": 1,
            "recordingId": "recording-1", "recordingSha256": RECORDING, "inputBytes": 441_322,
            "analysisVersion": ANALYSIS_VERSION, "automationId": "Automation_pipeline",
        }
        uuids = {"A": "11111111-1111-4111-8111-111111111111", "B": "22222222-2222-4222-8222-222222222222",
                 "C": "33333333-3333-4333-8333-333333333333", "D": "44444444-4444-4444-8444-444444444444"}
        reports = {}
        for step, official, fence in (("A", "run-a", 1), ("B", "run-b", 2), ("C", "run-c", 3), ("D", "cold-run", 9)):
            report = {"step": step, "officialRunId": official, "runId": uuids[step], "fence": fence,
                      "startedAt": f"2026-11-13T0{fence}:00:00Z",
                      "endedAt": f"2026-11-13T0{fence}:10:00Z", **common}
            reports[step] = report
        reports["C"].update({
            "coldOutputSha256": "9" * 64, "resumedOutputSha256": "9" * 64,
            "jobState": "completed", "duplicateFeedbackCount": 1, "feedbackVisible": True,
            "feedbackReceipt": {**{key: common[key] for key in (
                "jobId", "taskId", "attemptId", "attemptRevision", "recordingId",
                "recordingSha256", "inputBytes", "analysisVersion")},
                "fence": 3, "id": "receipt-1", "feedbackId": "feedback-1", "outputSha256": output_sha},
        })
        for step in ("A", "B", "C", "D"):
            (run / "runs" / f"{step.lower()}.json").write_text(json.dumps(reports[step]))

        history_runs = []
        for step in ("A", "B", "C", "D"):
            history_runs.append({
                **{key: reports[step][key] for key in (
                    "officialRunId", "startedAt", "endedAt", "automationId", "taskId")},
                "officialRecordRef": f"ref-{step}", "source": "scheduled-cloud",
                "clientExecution": False, "approvalPrompts": 0, "quotaObservation": "ok"})
        (run / "official" / "run-history.json").write_text(json.dumps(
            {"automationId": "Automation_pipeline", "runs": history_runs}))
        (run / "official" / "page.json").write_text(json.dumps(
            {"browser": "Chrome", "closeReceipt": "c", "reopenReceipt": "r",
             "closedAt": "2026-11-13T00:00:00Z", "reopenedAt": "2026-11-13T06:00:00Z"}))
        (run / "official" / "fairness.json").write_text(json.dumps(
            {"officialRunId": "run-c", "blockedTaskId": "b1", "laterTaskId": "b2",
             "blockedTaskRetried": True, "laterTaskCompleted": True}))

        events = []
        sequences = {
            "A": ("claimed", "retry_wait"),
            "B": ("claimed", "recording_verified", "checkpoint_saved", "interrupted"),
            "C": ("claimed", "checkpoint_restored", "suffix_completed", "feedback_committed", "receipt_readback"),
        }
        for step in ("A", "B", "C"):
            report = reports[step]
            for kind in sequences[step]:
                event = {"kind": kind, "type": kind, "source": "cloud",
                         "utc": report["startedAt"], "officialRunId": report["officialRunId"],
                         "fence": report["fence"],
                         **{key: common[key] for key in (
                             "jobId", "taskId", "attemptId", "attemptRevision", "recordingId",
                             "recordingSha256", "inputBytes", "analysisVersion")}}
                if kind == "retry_wait":
                    event.update(reason="recording_read_failed", nextAttemptAt="2026-11-13T01:01:00Z")
                elif kind == "recording_verified":
                    event.update(bytes=441_322, sha256=RECORDING)
                elif kind == "checkpoint_saved":
                    event.update(nextChunk=cut, checkpointSha256=transfer[cut - 1])
                elif kind == "interrupted":
                    event.update(recoverableAt="2026-11-13T03:00:00Z")
                elif kind == "checkpoint_restored":
                    event.update(nextChunk=cut, checkpointSha256=transfer[cut - 1])
                elif kind == "suffix_completed":
                    event.update(chunks=transfer[cut:])
                elif kind == "feedback_committed":
                    event.update(responseLost=True, receiptId="receipt-1")
                elif kind == "receipt_readback":
                    event.update(receiptId="receipt-1", feedbackId="feedback-1", outputSha256=output_sha)
                events.append(event)
            events.append({"kind": "offline_run", "type": "offline_run", "source": "cloud",
                           "utc": report["startedAt"], "officialRunId": report["officialRunId"],
                           "fence": report["fence"], "automationId": "Automation_pipeline",
                           "isolated": True, "jobId": common["jobId"]})

        wakes = []
        for index in range(3):
            at = 1_763_000_000_000 + index * 90_000_000
            events.append({"kind": "wake", "type": "wake", "source": "scheduled-cloud", "at": at,
                           "utc": f"2026-11-1{index}T00:00:00Z", "pendingCount": 0,
                           "pendingAcoustics": 0, "subscriptionActive": True, "emptyQueueAccepted": True})
            wakes.append({"at": at, "officialRunId": f"wake-{index}",
                          "officialRecordRef": f"wref-{index}",
                          "startedAt": f"2026-11-1{index}T00:00:00Z"})
        (run / "site" / "site-events.json").write_text(json.dumps({"events": events}))
        (run / "official" / "wake-runs.json").write_text(json.dumps({"wakes": wakes}))

        stage_prefix = sha(g5.acoustic_manifest(expected_identity, plan, raw_chunks[:cut]))
        stage_all = sha(g5.acoustic_manifest(expected_identity, plan, raw_chunks))
        workers = [
            {"executionId": "e1", "officialRunId": "run-b", **common, "fence": 2,
             "source": "cloud-executor", "localExecution": False, "readBytes": 441_322,
             "decoderInputSha256": RECORDING, "savedChunks": transfer[:cut],
             "stageIndexSha256": stage_prefix},
            {"executionId": "e2", "officialRunId": "run-c", **common, "fence": 3,
             "source": "cloud-executor", "localExecution": False, "readBytes": 441_322,
             "decoderInputSha256": RECORDING, "restoredChunks": transfer[:cut],
             "newChunks": transfer[cut:], "stageIndexSha256": stage_all, "logits": logits,
             "outputSha256": output_sha},
            {"executionId": "e3", "officialRunId": "cold-run", **common,
             "source": "cloud-executor", "localExecution": False, "readOnly": True,
             "cacheEmpty": True, "restoredChunks": [], "newChunks": transfer,
             "readBytes": 441_322, "decoderInputSha256": RECORDING,
             "stageIndexSha256": stage_all, "logits": logits, "outputSha256": output_sha,
             "coldOfficialRecordRef": "ref-D"},
        ]
        (run / "executor" / "runs.json").write_text(json.dumps({"runs": workers}))
        for path in ("platform/platform-probe.json", "platform/runtime-profile.json",
                     "browser/browser-acceptance.json", "browser/browser-playback-events.json"):
            (run / path).write_text("{}")

        g5.build(run, out, static)
        check(g5.check(out, require_signatures=False) == 0, "export_g5_evidence --check accepts the built bundle")

        manifest = json.loads((out / "manifest.json").read_text())
        offline = json.loads((out / "offline.json").read_text())
        recovery = json.loads((out / "acoustic-recovery.json").read_text())
        config = json.loads((static / "analysis-config.json").read_text())
        site = json.loads((out / "site-event-export.json").read_text())
        exported = json.loads((out / "executor-event-export.json").read_text())
        by_type = {row["type"]: row for row in site["events"] if row["type"] in ("checkpoint_saved", "checkpoint_restored", "suffix_completed")}
        b_event = {"checkpoint_saved": by_type["checkpoint_saved"]}
        c_event = {"checkpoint_restored": by_type["checkpoint_restored"],
                   "suffix_completed": by_type["suffix_completed"]}
        try:
            cloud.verify_acoustic(out, manifest, offline, recovery, config, b_event, c_event, exported["runs"])
            check(True, "real verify_acoustic accepts the exported bundle (option 2)")
        except Exception as error:  # noqa: BLE001
            check(False, f"real verify_acoustic accepts the exported bundle: {type(error).__name__}: {error}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    plan_equivalence()
    integration()
    export_pipeline()
    print(f"\n{'PASS' if FAILURES == 0 else 'FAIL'}: {FAILURES} failure(s)")
    return 0 if FAILURES == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())