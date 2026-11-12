#!/usr/bin/env python3
"""Verify the signed, isolated scheduled-Work release without changing the checkout."""

import argparse
from hashlib import file_digest, sha256
import json
import math
from pathlib import Path
import subprocess
from zipfile import BadZipFile, ZipFile

from verify_release import (
    BROWSER_CASES, FILES as OLD_FILES, IDENTITY, PRESERVED, SUBJECT,
    digest, integer, local_file, nonempty, read_json, require, same, utc,
    verify_browser_playback, verify_holdout, verify_offline_output, verify_platform_probes, verify_signatures,
)
from bandroom_acoustic.acoustic_stage import AcousticStore, PASS_OFFSETS, read_chunk, windows
from bandroom_acoustic.checkpoint import read_checkpoint

NAMESPACE = "bandroom-d2-cloud-recovery-v1"
CANDIDATE = (*IDENTITY, "sourceTreeSha", "runtimeBundleSha256", "modelWeightsSha256", "configSha256")
TASK = (*SUBJECT, *CANDIDATE)
FILES = set(OLD_FILES) - {"candidate.json", "work-runs.json", "mac-probes.json", "official-run-history.zip",
                         "offline-inference.json", "offline-reference.json"} | {
    "runtime-bundle.zip", "runtime-profile.json", "official-run-history.json", "executor-event-export.json",
    "acoustic-recovery.json", "offline-cold-output.json",
}
ENCODINGS = {"mp4/aac", "webm/opus"}
MAX_RUNTIME_BYTES = 300_000_000
WORK_EVENTS = (
    ("claimed", "retry_wait"),
    ("claimed", "recording_verified", "checkpoint_saved", "interrupted"),
    ("claimed", "checkpoint_restored", "suffix_completed", "feedback_committed", "receipt_readback"),
)


def hash_file(path):
    with path.open("rb") as data:
        return file_digest(data, "sha256").hexdigest()


def verify_source(repo, manifest, phase):
    def git(*args):
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)
        require(result.returncode == 0, "could not verify signed Git identity: " + " ".join(args))
        return result.stdout.strip()

    if phase == "candidate":
        require(git("rev-parse", "HEAD") == manifest["sourceSha"], "candidate base differs from the signed commit")
        require(not git("ls-files", "--others", "--exclude-standard"), "candidate contains untracked files")
        git("diff", "--quiet", "--ignore-submodules=none")
        tree = git("write-tree")
    else:
        require(not git("status", "--porcelain", "--untracked-files=all"), "release checkout is dirty")
        git("merge-base", "--is-ancestor", manifest["sourceSha"], "HEAD")
        tree = git("rev-parse", "HEAD^{tree}")
    require(tree == manifest["sourceTreeSha"], "source tree differs from the signed release tree")


def verify_zero_cost(document):
    require(integer(document["invoicesAdded"]) and document["invoicesAdded"] == 0
            and document["newSubscriptions"] == document["newPaidApiKeys"] == []
            and all(document[name] is False for name in (
                "gpuRental", "paidAnnotation", "paidCorpusOrModel", "storageOrDatabaseUpgrade", "paidCiOrMonitoring",
            ))
            and all(document[name] == "existing" for name in ("workPlan", "sitesPlan", "githubPlan"))
            and nonempty(document["signedBy"]), "zero-cost owner attestation is incomplete")
    utc(document["signedAt"])


def verify_work(offline, history, site, executor, recovery):
    runs = offline["runs"]
    require(len(runs) == 3 and [run["step"] for run in runs] == ["A", "B", "C"],
            "three scheduled runs are required for the same isolated task")
    require(all(nonempty(offline[key]) for key in ("jobId", "taskId", "attemptId", "recordingId"))
            and digest(offline["recordingSha256"]) and integer(offline["inputBytes"], 1)
            and integer(offline["attemptRevision"], 1) and offline["isolated"] is True,
            "invalid isolated attempt and recording identity")
    run_ids = [run["officialRunId"] for run in runs]
    fences = [run["fence"] for run in runs]
    require(all(nonempty(run_id) for run_id in run_ids) and len(set(run_ids)) == 3
            and all(integer(fence, 1) for fence in fences) and fences[0] < fences[1] < fences[2]
            and nonempty(history["automationId"]), "run identities and fences must be distinct and increasing")
    records = {row["officialRunId"]: row for row in history["runs"]}
    cold_id = recovery["coldRunId"]
    require(len(records) == len(history["runs"]) and set(run_ids + [cold_id]) <= records.keys()
            and cold_id not in run_ids, "official export lacks distinct recovery and cold runs")
    page = offline["page"]
    require(page["browser"] == "Chrome" and nonempty(page["closeReceipt"]) and nonempty(page["reopenReceipt"])
            and utc(page["closedAt"]) < utc(runs[0]["startedAt"])
            and utc(runs[2]["endedAt"]) < utc(page["reopenedAt"])
            and site["clientOperationsDuringClosure"] == [], "the original page did not stay closed for all work")

    for index, run in enumerate(runs):
        record = records[run["officialRunId"]]
        require(same(run, offline, TASK) and same(record, run, ("startedAt", "endedAt", "automationId", "taskId"))
                and record["automationId"] == history["automationId"] and nonempty(record["officialRecordRef"])
                and record["source"] == "scheduled-cloud" and record["clientExecution"] is False
                and integer(record["approvalPrompts"]) and record["approvalPrompts"] == 0
                and nonempty(record["quotaObservation"])
                and 0 < (utc(run["endedAt"]) - utc(run["startedAt"])).total_seconds() <= 900
                and (index == 0 or utc(runs[index - 1]["endedAt"]) <= utc(run["startedAt"])),
                "official history does not corroborate an independent, unattended recovery run")

    by_step = []
    all_events = site["events"]
    require(len(all_events) == sum(map(len, WORK_EVENTS)), "isolated event export is incomplete or ambiguous")
    for run, expected in zip(runs, WORK_EVENTS, strict=True):
        events = [row for row in all_events if row["officialRunId"] == run["officialRunId"]]
        require([row["type"] for row in events] == list(expected)
                and all(same(row, run, (*SUBJECT, "fence")) and row["source"] == "cloud"
                        and utc(run["startedAt"]) <= utc(row["at"]) <= utc(run["endedAt"]) for row in events)
                and all(utc(left["at"]) <= utc(right["at"]) for left, right in zip(events, events[1:])),
                "server did not observe the expected cloud events under the same lease")
        by_step.append({row["type"]: row for row in events})

    a, b, c = by_step
    retry = a["retry_wait"]
    require(retry["reason"] in {"recording_read_failed", "recording_range_truncated"}
            and utc(retry["at"]) < utc(retry["nextAttemptAt"]) <= utc(b["claimed"]["at"]),
            "retry must be registered before the next independent run becomes eligible")
    require(utc(b["interrupted"]["at"]) <= utc(b["interrupted"]["recoverableAt"]) <= utc(c["claimed"]["at"]),
            "recovery did not wait for the interrupted lease or retry")
    receipt = offline["feedbackReceipt"]
    require(site["feedbackReceipt"] == receipt and same(receipt, offline, SUBJECT)
            and receipt["fence"] == fences[2] and nonempty(receipt["id"]) and nonempty(receipt["feedbackId"])
            and digest(receipt["outputSha256"]) and offline["jobState"] == "completed"
            and integer(offline["duplicateFeedbackCount"], 1) and offline["duplicateFeedbackCount"] == 1
            and offline["feedbackVisible"] is True
            and c["feedback_committed"]["responseLost"] is True
            and c["feedback_committed"]["receiptId"] == c["receipt_readback"]["receiptId"] == receipt["id"]
            and c["receipt_readback"]["feedbackId"] == receipt["feedbackId"]
            and c["receipt_readback"]["outputSha256"] == receipt["outputSha256"]
            and utc(c["feedback_committed"]["at"]) <= utc(c["receipt_readback"]["at"]),
            "lost response did not recover the original feedback receipt")

    workers = executor["runs"]
    require(len(workers) == 3 and [row["officialRunId"] for row in workers] == run_ids[1:] + [cold_id]
            and len({row["executionId"] for row in workers}) == 3,
            "cloud execution export must identify the independent prefix, resume and cold executions")
    for worker, run in zip(workers[:2], runs[1:], strict=True):
        require(nonempty(worker["executionId"]) and same(worker, run, (*TASK, "fence"))
                and worker["source"] == "cloud-executor" and worker["localExecution"] is False
                and utc(run["startedAt"]) <= utc(worker["startedAt"]) < utc(worker["endedAt"]) <= utc(run["endedAt"]),
                "cloud executor receipt does not bind to the official run and fence")
    cold, cold_record = workers[2], records[cold_id]
    require(same(cold, offline, TASK) and nonempty(cold["executionId"])
            and cold["source"] == "cloud-executor" and cold["localExecution"] is False
            and cold["readOnly"] is True and cold["cacheEmpty"] is True and cold["restoredChunks"] == []
            and cold_record["taskId"] == offline["taskId"] and nonempty(cold_record["officialRecordRef"])
            and cold_record["source"] == "scheduled-cloud" and cold_record["clientExecution"] is False
            and integer(cold_record["approvalPrompts"]) and cold_record["approvalPrompts"] == 0
            and nonempty(cold_record["quotaObservation"])
            and 0 < (utc(cold_record["endedAt"]) - utc(cold_record["startedAt"])).total_seconds() <= 900
            and utc(cold_record["startedAt"]) <= utc(cold["startedAt"]) < utc(cold["endedAt"])
            <= utc(cold_record["endedAt"]), "cold comparison lacks an independent read-only cloud execution")
    read = b["recording_verified"]
    require(read["bytes"] == workers[0]["readBytes"] == offline["inputBytes"]
            and read["sha256"] == workers[0]["computedSha256"] == workers[0]["decoderInputSha256"]
            == offline["recordingSha256"], "full original audio did not reach the cloud decoder")
    require(cold["readBytes"] == offline["inputBytes"] and cold["decoderInputSha256"] == offline["recordingSha256"],
            "cold comparison did not decode the same original")
    fairness = offline["fairness"]
    fair_run = records.get(fairness["officialRunId"], {})
    require(nonempty(fairness["blockedTaskId"]) and nonempty(fairness["laterTaskId"])
            and len({fairness["blockedTaskId"], fairness["laterTaskId"], offline["taskId"]}) == 3
            and fairness["blockedTaskRetried"] is True and fairness["laterTaskCompleted"] is True
            and fair_run.get("taskId") == fairness["laterTaskId"]
            and fair_run.get("automationId") == history["automationId"]
            and fair_run.get("source") == "scheduled-cloud" and fair_run.get("clientExecution") is False
            and integer(fair_run.get("approvalPrompts")) and fair_run["approvalPrompts"] == 0
            and nonempty(fair_run.get("officialRecordRef")), "missing queue fairness readback")
    empty = history["emptyQueueWakes"]
    require(len({row["officialRunId"] for row in empty}) == len(empty) >= 3
            and all(row["officialRunId"] not in records and nonempty(row["officialRecordRef"])
                    and row["automationId"] == history["automationId"] and row["source"] == "scheduled-cloud"
                    and row["clientExecution"] is False
                    and all(integer(row[key]) and row[key] == 0 for key in (
                        "approvalPrompts", "discoveredCount", "createdCount",
                    )) for row in empty)
            and (max(utc(row["startedAt"]) for row in empty) -
                 min(utc(row["startedAt"]) for row in empty)).total_seconds() >= 86_400,
            "missing empty-queue evidence across at least 24 hours and three scheduled wakes")
    return b, c, workers, records


def verify_runtime(probes, profile, history_sha256, records, offline, bundle_bytes):
    verify_platform_probes(probes, offline, history_sha256)
    for probe in probes["probes"]:
        for key in ("readRun", "resumeRun"):
            run = probe[key]
            require(run["officialRunId"] in records
                    and same(records[run["officialRunId"]], run, ("automationId", "startedAt", "endedAt", "taskId",
                                                               "source", "approvalPrompts", "quotaObservation")),
                    "platform probe is absent from the official run history")
    phases = {"download", "prepare", "decode", "asr", "acoustic", "candidates", "validate", "writeback"}
    trials = profile["coldTrials"]
    require(len({row["officialRunId"] for row in trials}) == len(trials)
            and all(sum(row["encoding"] == encoding for row in trials) >= 3 for encoding in ENCODINGS),
            "three distinct cold runs per encoding are required")
    for trial in trials:
        record = records[trial["officialRunId"]]
        times = trial["stageSeconds"]
        require(same(trial, offline, CANDIDATE) and trial["encoding"] in ENCODINGS
                and trial["cacheEmpty"] is True and 165_000 <= trial["durationMs"] <= 180_000
                and record["source"] == "scheduled-cloud" and record["clientExecution"] is False
                and integer(record["approvalPrompts"]) and record["approvalPrompts"] == 0
                and nonempty(record["officialRecordRef"]) and nonempty(record["quotaObservation"])
                and nonempty(trial["environmentFingerprint"]) and nonempty(trial["processor"])
                and nonempty(trial["sourceLimitObservation"]) and set(times) == phases
                and all(type(value) in (float, int) and math.isfinite(value) and value > 0 for value in times.values())
                and times["download"] + times["prepare"] <= 300
                and sum(times.values()) <= trial["executionSeconds"] <= 900
                and trial["executionSeconds"] <= (utc(record["endedAt"]) - utc(record["startedAt"])).total_seconds()
                and integer(trial["coldBytes"], bundle_bytes) and trial["coldBytes"] <= MAX_RUNTIME_BYTES
                and integer(trial["processTreePeakBytes"], 1) and trial["processTreePeakBytes"] <= 8_000_000_000,
                "a scheduled cold trial exceeds the reviewed runtime budget or lacks measurements")


def verify_acoustic(bundle, manifest, offline, recovery, config, b, c, workers):
    hashes = manifest["files"]
    decode_sha = hashes["offline-checkpoint.bin"]
    decoded = read_checkpoint(bundle / "offline-checkpoint.bin", input_sha256=offline["recordingSha256"],
                              artifact_sha256=decode_sha, analysis_version=offline["analysisVersion"])
    plan = list(windows(decoded.sample_count))
    identity = recovery["identity"]
    stage = config["acousticConfig"]
    require(stage["analysisVersion"] == manifest["analysisVersion"],
            "acoustic configuration does not match the release analysis version")
    with ZipFile(bundle / "runtime-bundle.zip") as runtime:
        index = runtime.getinfo("cloud-stage.json")
        require(0 < index.file_size <= 1_048_576, "runtime bundle index exceeds its size limit")
        lock = read_json(runtime.read(index))["files"]
        for name, key in (("encoder-int8.onnx", "encoderSha256"), ("probe-head.onnx", "headSha256")):
            entry = runtime.getinfo(f"graphs/{name}")
            require(0 < entry.file_size <= MAX_RUNTIME_BYTES, "model graph exceeds its size limit")
            with runtime.open(entry) as graph:
                graph_sha = file_digest(graph, "sha256").hexdigest()
            require(stage[key] == lock[entry.filename] == graph_sha,
                    "acoustic configuration does not match the frozen model graphs")
    stage_sha = sha256(json.dumps(stage, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    expected = {
        "environment": offline["environmentId"], "taskId": offline["taskId"], "attemptId": offline["attemptId"],
        "revision": offline["attemptRevision"], "inputSha256": offline["recordingSha256"],
        "inputBytes": offline["inputBytes"], "decodeSha256": decode_sha,
        "bundleSha256": manifest["runtimeBundleSha256"], "configSha256": stage_sha,
    }
    require(decoded.input_bytes == offline["inputBytes"] and identity == expected,
            "decoded checkpoint or feature identity differs from the signed original")
    prefix, resumed, cold = (recovery[key] for key in ("prefix", "resumed", "cold"))
    first, last = b["checkpoint_saved"], c["checkpoint_restored"]
    cut = len(prefix)
    require(0 < cut < len(plan) and len(resumed) == len(plan) and prefix == resumed[:cut]
            and resumed == cold and len(set(resumed)) == len(resumed)
            and first["nextChunk"] == last["nextChunk"] == cut
            and first["checkpointSha256"] == last["checkpointSha256"] == prefix[-1]
            and workers[0]["savedChunks"] == prefix and workers[1]["restoredChunks"] == prefix
            and workers[1]["newChunks"] == resumed[cut:] and c["suffix_completed"]["chunks"] == resumed[cut:]
            and workers[2]["newChunks"] == cold,
            "cloud execution did not restore the genuine prefix and continue with an independently reproduced suffix")
    previous = decode_sha
    rows = []
    for index, (expected_digest, window) in enumerate(zip(resumed, plan, strict=True)):
        name = f"acoustic-{index:02}.bin"
        require(hashes.get(name) == expected_digest, "chunk not bound to the release manifest")
        raw = read_chunk(local_file(bundle, name), expected_digest, identity, index, previous, window.bytes)
        rows.append({"bytes": len(raw), "sha256": sha256(raw).hexdigest()})
        previous = expected_digest
    store = AcousticStore(bundle, identity, plan)
    require(workers[0]["stageIndexSha256"] == sha256(store.manifest(rows[:cut])).hexdigest()
            and workers[1]["stageIndexSha256"] == workers[2]["stageIndexSha256"] == recovery["coldStageIndexSha256"]
            == sha256(store.manifest(rows)).hexdigest(), "acoustic checkpoint indexes do not reproduce")
    logits = workers[1]["logits"]
    require(logits == workers[2]["logits"] == recovery["coldLogits"]
            and [row["offset"] for row in logits] == list(PASS_OFFSETS)
            and all(row["frames"] == sum(w.end_frame - w.start_frame for w in plan if w.offset == row["offset"])
                    and all(digest(row[key]) for key in ("frameSha256", "ctcSha256", "boundarySha256"))
                    for row in logits), "recovered and cold head output differ")
    require(hashes["offline-output.json"] == hashes["offline-cold-output.json"]
            == workers[1]["outputSha256"] == workers[2]["outputSha256"],
            "completed feedback does not reproduce from a cold run")
    return decoded


def verify_browser(docs, manifest, offline, decoded):
    browser = docs["browser-acceptance.json"]
    before, after = browser["learnerBaselineBefore"], browser["learnerBaselineAfter"]
    require(same(browser, offline, SUBJECT) and browser["feedbackId"] == offline["feedbackReceipt"]["feedbackId"]
            and browser["receiptId"] == offline["feedbackReceipt"]["id"]
            and PRESERVED <= before.keys() and before == after and browser["rollbackVerified"] is True
            and nonempty(browser["browsers"]["Chrome"]["version"])
            and all(browser["cases"].get(case, {}).get("status") == "passed"
                    and nonempty(browser["cases"][case].get("receipt")) for case in BROWSER_CASES | {
                        "slow-loadedmetadata", "repeat-marker", "pause", "reopen",
                    }), "isolated Chrome regression, historical state or rollback evidence is missing")
    reference = docs["adjudicated.json"]
    clip_id = offline["holdoutClipId"]
    clip, = [clip for clip in reference["clips"] if clip["clipId"] == clip_id]
    require(clip["audioSha256"] == offline["recordingSha256"] and clip["sampleRateHz"] == 16000
            and clip["sampleCount"] == decoded.sample_count,
            "end-to-end test must use the exact independently adjudicated original")
    words, = [clip for clip in docs["reference-words.json"]["clips"] if clip["clipId"] == clip_id]
    output = docs["offline-output.json"]
    event, human = verify_offline_output(output, {
        **offline, "reviewerId": reference["reviewerId"],
        "errors": [{**error, "word": words["words"][error["wordIndex"]]["word"]} for error in clip["errors"]],
    }, {**offline, "browser": offline["page"]}, manifest["files"]["offline-output.json"])
    require(output["analysis"]["decoded"]["sampleCount"] == decoded.sample_count,
            "completed output is on a different timeline from the original")
    verify_browser_playback(docs["browser-playback-events.json"], browser, offline, event, human,
                            decoded.decoded_duration_ms, browsers=("Chrome",),
                            timeline_encodings={("Chrome", encoding) for encoding in ENCODINGS}, require_metadata=True)


def verify_bundle(bundle, trusted_signers, legacy_dir, repo, recording_root, phase):
    raw = local_file(bundle, "manifest.json").read_bytes()
    verify_signatures(bundle, raw, trusted_signers, NAMESPACE)
    manifest = read_json(raw)
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1
            and manifest["protocol"] == NAMESPACE and manifest["route"] == "A"
            and all(digest(manifest[key], 40) for key in ("sourceSha", "sourceTreeSha"))
            and all(nonempty(manifest[key]) for key in ("analysisVersion", "environmentId")),
            "invalid scheduled-Work release identity")
    hashes = manifest["files"]
    require(FILES <= hashes.keys() and all(digest(value) for value in hashes.values())
            and all(hashes[name] == manifest[key] for name, key in (
                ("site-build.tar.gz", "buildSha256"), ("runtime-bundle.zip", "runtimeBundleSha256"),
                ("model-weights.bin", "modelWeightsSha256"), ("analysis-config.json", "configSha256"),
            )), "missing or conflicting signed build, runtime, model or configuration hashes")
    runtime_bytes = local_file(bundle, "runtime-bundle.zip").stat().st_size
    require(0 < runtime_bytes <= MAX_RUNTIME_BYTES, "runtime bundle exceeds the reviewed download limit")
    recovery = read_json(local_file(bundle, "acoustic-recovery.json").read_bytes())
    require(0 < len(recovery["resumed"]) <= 24 and set(hashes) == FILES | {
        f"acoustic-{index:02}.bin" for index in range(len(recovery["resumed"]))
    }, "invalid signed evidence inventory")
    docs = {}
    for name, expected in hashes.items():
        path = local_file(bundle, name)
        require(hash_file(path) == expected, f"digest mismatch for {name}")
        if name.endswith(".json"):
            docs[name] = read_json(path.read_bytes())
    for name in ("gates.json", "zero-cost.json", "offline.json", "runtime-profile.json", "official-run-history.json",
                 "site-event-export.json", "executor-event-export.json", "acoustic-recovery.json", "platform-probe.json",
                 "browser-acceptance.json", "browser-playback-events.json", "holdout-ledger.json",
                 "inference-windows.json"):
        require(same(docs[name], manifest, CANDIDATE), f"{name} belongs to a different candidate")
    gates = docs["gates.json"]
    require(gates["releaseEligible"] is True and all(gates["gates"][f"G{index}"]["status"] == "passed"
                                                   for index in range(6)), "release is still ineligible")
    verify_source(repo, manifest, phase)
    verify_zero_cost(docs["zero-cost.json"])
    verify_holdout(bundle, docs, manifest, legacy_dir, recording_root, ("runtime-bundle.zip",))
    offline = docs["offline.json"]
    recovery = docs["acoustic-recovery.json"]
    b, c, workers, records = verify_work(offline, docs["official-run-history.json"], docs["site-event-export.json"],
                                        docs["executor-event-export.json"], recovery)
    verify_runtime(docs["platform-probe.json"], docs["runtime-profile.json"], hashes["official-run-history.json"],
                   records, offline, runtime_bytes)
    decoded = verify_acoustic(bundle, manifest, offline, recovery, docs["analysis-config.json"], b, c, workers)
    verify_browser(docs, manifest, offline, decoded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--trusted-signers", type=Path, required=True)
    parser.add_argument("--legacy-dir", type=Path, required=True, help="trusted holdout and scoring scripts")
    parser.add_argument("--recordings", type=Path, required=True, help="consented private holdout originals")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--phase", choices=("candidate", "release"), required=True)
    args = parser.parse_args()
    try:
        verify_bundle(args.evidence.resolve(), args.trusted_signers.resolve(), args.legacy_dir.resolve(),
                      args.repo.resolve(), args.recordings.resolve(), args.phase)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError, IndexError, BadZipFile) as error:
        parser.exit(1, f"BLOCKED: {error}\n")
    print(f"READY: {NAMESPACE} signed evidence and {args.phase} tree passed.")


if __name__ == "__main__":
    main()
