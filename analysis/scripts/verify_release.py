#!/usr/bin/env python3
"""Verify the signed release evidence for D2 route A (scheduled ChatGPT Work)."""

import argparse
import base64
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import runpy
from statistics import median
import subprocess
import sys

from align_predictions import align

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bandroom_acoustic.checkpoint import read_checkpoint

NAMESPACE = "bandroom-d2-release-v2"
ROLES = ("release-owner", "holdout-custodian", "work-auditor", "site-auditor")
IDENTITY = ("sourceSha", "buildSha256", "analysisVersion", "environmentId", "route")
SUBJECT = ("jobId", "taskId", "attemptId", "attemptRevision", "recordingId", "recordingSha256", "inputBytes", "analysisVersion")
FILES = (
    "site-build.tar.gz", "analysis-bundle.tar.zst", "model-weights.bin", "analysis-config.json",
    "candidate.json", "zero-cost.json", "gates.json", "preflight.json", "score.json", "stratified-score.json",
    "holdout-inventory.json", "annotator-a.json", "annotator-b.json", "adjudicated.json",
    "predictions.json", "aligned-predictions.json", "word-map.json", "reference-words.json",
    "holdout-ledger.json", "inference-windows.json", "offline.json", "work-runs.json",
    "mac-probes.json", "platform-probe.json", "browser-acceptance.json",
    "official-run-history.zip", "site-event-export.json", "offline-checkpoint.bin", "offline-inference.json",
    "offline-output.json", "offline-reference.json", "browser-playback-events.json",
)
BROWSER_CASES = {
    "final-chunk", "save-delay", "api-failure", "session-expired", "refresh", "double-click",
    "multiple-tabs", "stale-retake-callback", "playback", "archive",
}
PRESERVED = {"part2Recording", "scores", "feedback", "day12Status", "day13Unlocked"}
ERROR_ID = ("wordIndex", "phoneIndex", "kind", "target", "actual")
RETRYABLE_RECORDING_ERRORS = {"recording_read_failed", "recording_range_truncated"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value, length=64):
    return isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value) is not None


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def utc(value):
    require(isinstance(value, str) and value.endswith("Z"), f"expected a UTC timestamp, got {value!r}")
    return datetime.fromisoformat(value[:-1] + "+00:00")


def same(actual, expected, keys):
    return all(key in actual and key in expected and actual[key] == expected[key] for key in keys)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key {key}")
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError(f"non-finite JSON value {value}")


def finite_float(value):
    number = float(value)
    require(math.isfinite(number), f"non-finite JSON value {value}")
    return number


def read_json(data):
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant, parse_float=finite_float)


def local_file(directory, name):
    path = directory / name
    require(path.is_file() and not path.is_symlink(), f"missing regular evidence file {name}")
    return path


def verify_signatures(bundle, manifest, trusted_signers, namespace=NAMESPACE):
    require(not trusted_signers.resolve().is_relative_to(bundle.resolve()),
            "the allowed-signers file must be distributed outside the evidence bundle")
    keys = {}
    for line in trusted_signers.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        role, algorithm, key = line.split()
        require(role in ROLES and role not in keys and algorithm == "ssh-ed25519",
                "use one explicit Ed25519 key per trusted role")
        keys[role] = base64.b64decode(key, validate=True)
    require(set(keys) == set(ROLES) and len(set(keys.values())) == len(ROLES),
            "all roles require distinct pre-established trust keys")
    for role in ROLES:
        signature = local_file(bundle, role + ".sig")
        verified = subprocess.run([
            "ssh-keygen", "-Y", "verify", "-f", str(trusted_signers), "-I", role,
            "-n", namespace, "-s", str(signature),
        ], input=manifest, capture_output=True, check=False)
        require(verified.returncode == 0, f"invalid release manifest signature for {role}")


def verify_ranges(ranges, offline):
    cursor = 0
    accepted = set()
    for event in sorted(ranges, key=lambda event: event["metadata"]["offset"]):
        meta = event["metadata"]
        require(integer(meta["offset"]) and integer(meta["length"], 1)
                and meta["total"] == offline["inputBytes"] and meta["sha256"] == offline["recordingSha256"]
                and meta["recordingId"] == offline["recordingId"], "invalid or noncontiguous original-audio range")
        byte_range = meta["offset"], meta["length"]
        if byte_range in accepted:
            continue
        require(meta["offset"] == cursor, "noncontiguous original-audio range")
        accepted.add(byte_range)
        cursor += meta["length"]
    require(cursor == offline["inputBytes"], "original-audio read did not cover every byte")


def verify_work_runs(offline, official, probes):
    start, end = utc(offline["offlineStart"]), utc(offline["offlineEnd"])
    require(start < end and utc(offline["browser"]["closedAt"]) <= start
            and utc(offline["browser"]["reopenedAt"]) >= end, "invalid browser/offline window")
    require(all(nonempty(offline[key]) for key in ("jobId", "taskId", "attemptId", "recordingId", "analysisVersion"))
            and integer(offline["attemptRevision"], 1) and integer(offline["inputBytes"], 1)
            and digest(offline["recordingSha256"]), "invalid offline task identity")
    require(len(offline["runs"]) == len(official["runs"]) == 3 and nonempty(official["automationId"]),
            "require exactly three independently corroborated scheduled runs")
    ids = ("officialRunId", "clientRunId", "startedAt", "endedAt", "fences")
    seen_official, by_client = set(), {}
    for observed, run in zip(offline["runs"], official["runs"]):
        require(same(observed, run, ids) and same(run["subject"], offline, SUBJECT),
                "official run disagrees with the offline run or its task")
        require(nonempty(run["officialRunId"]) and run["officialRunId"] not in seen_official
                and nonempty(run["clientRunId"]) and run["clientRunId"] not in by_client
                and len(run["fences"]) == 1 and integer(run["fences"][0], 1)
                and run["source"] == "scheduled-cloud" and run["automationId"] == official["automationId"]
                and integer(run["approvalPrompts"]) and run["approvalPrompts"] == 0,
                "official cloud run identity, fence or approval evidence is invalid")
        seen_official.add(run["officialRunId"])
        by_client[run["clientRunId"]] = run

    a, b, c = official["runs"]
    times = [utc(run[key]) for run in (a, b, c) for key in ("startedAt", "endedAt")]
    a_start, a_end, b_start, b_end, c_start, c_end = times
    require(a_start <= a_end < start <= b_start < b_end < c_start < c_end <= end
            and a["fences"][0] < b["fences"][0] < c["fences"][0], "cloud run windows or fences overlap")

    events = {}
    before_offline = offline["beforeOfflineEvents"]
    server_events = offline["serverEvents"]
    require(all(event["clientRunId"] == a["clientRunId"] for event in before_offline)
            and all(event["clientRunId"] in (b["clientRunId"], c["clientRunId"]) for event in server_events),
            "server events are misclassified relative to the offline window")
    for event in [*before_offline, *server_events]:
        run = by_client[event["clientRunId"]]
        when = utc(event["at"])
        require(event["taskId"] == offline["taskId"] and event["fence"] == run["fences"][0]
                and utc(run["startedAt"]) <= when <= utc(run["endedAt"]),
                "server event falls outside its task, lease fence or cloud run")
        events.setdefault((run["clientRunId"], event["tool"], event["outcome"]), []).append(event)

    def for_run(run, tool, outcome="ok"):
        return events.get((run["clientRunId"], tool, outcome), [])

    def one(run, tool, outcome="ok"):
        selected = for_run(run, tool, outcome)
        require(len(selected) == 1, f"require one {tool}/{outcome} event for {run['clientRunId']}")
        return selected[0]

    def at(event):
        return utc(event["at"])

    def binary_checkpoint(run, tool):
        selected = [event for event in for_run(run, tool) if event["metadata"].get("transport") == "binary-v1"]
        require(len(selected) == 1, f"require one binary decode checkpoint {tool} for {run['clientRunId']}")
        return selected[0]

    a_claim = one(a, "claim_review_tasks")
    read_error = one(a, "read_review_recording", "error")
    retry = one(a, "fail_review_task", "retry_wait")
    require(at(a_claim) <= at(read_error) <= at(retry)
            and read_error["metadata"]["code"] in RETRYABLE_RECORDING_ERRORS
            and retry["metadata"]["code"] == read_error["metadata"]["code"]
            and integer(retry["metadata"]["nextAt"], 1)
            and at(retry).timestamp() * 1000 <= retry["metadata"]["nextAt"] <= b_start.timestamp() * 1000,
            "retry state does not follow the recording read failure or became due after the retry run")

    ranges = for_run(b, "read_review_recording")
    verify_ranges(ranges, offline)
    b_claim = one(b, "claim_review_tasks")
    saved = binary_checkpoint(b, "save_review_checkpoint")
    c_claim = one(c, "claim_review_tasks")
    resumed = binary_checkpoint(c, "read_review_checkpoint")
    complete = one(c, "complete_review_task")
    readback = one(c, "read_review_receipt")
    receipt = offline["feedbackReceipt"]
    require(at(b_claim) <= min(map(at, ranges)) <= max(map(at, ranges)) <= at(saved) < b_end
            and b["disposition"] == "interrupted" and c["completionResponseLost"] is True
            and complete["stage"] == readback["stage"] == "finalize",
            "decode was not saved after the complete audio read and before interruption")
    require(at(c_claim) <= at(resumed) <= utc(c["checkpointVerifiedAt"])
            <= utc(receipt["createdAt"]) <= at(complete) <= at(readback),
            "resumption, receipt creation, completion and readback must be causal")
    b_audio = b["originalAudio"]
    require(b_audio["computedSha256"] == offline["recordingSha256"]
            and b_audio["bytes"] == offline["inputBytes"]
            and max(map(at, ranges)) <= utc(b_audio["verifiedAt"]) <= at(saved),
            "Work did not verify the full reassembled original-audio digest")
    checkpoint = saved["metadata"]
    require(saved["stage"] == resumed["stage"] == "decode"
            and same(checkpoint, resumed["metadata"],
                     ("analysisVersion", "chunkIndex", "artifactSha256", "inputSha256", "inputBytes", "bytes"))
            and integer(checkpoint["chunkIndex"]) and checkpoint["chunkIndex"] == 0
            and checkpoint["inputSha256"] == offline["recordingSha256"]
            and checkpoint["inputBytes"] == offline["inputBytes"]
            and checkpoint["analysisVersion"] == offline["analysisVersion"]
            and c["verifiedCheckpointSha256"] == checkpoint["artifactSha256"]
            and digest(checkpoint["artifactSha256"]) and integer(checkpoint["bytes"], 1),
            "the new lease did not read the same durable decode checkpoint")
    require(same(receipt, offline, ("taskId", "attemptId", "attemptRevision", "recordingSha256", "analysisVersion"))
            and receipt["fence"] == c["fences"][0] and digest(receipt["outputSha256"])
            and nonempty(receipt["id"]) and nonempty(receipt["feedbackId"])
            and all(event["metadata"]["receiptId"] == receipt["id"]
                    and event["metadata"]["feedbackId"] == receipt["feedbackId"] for event in (complete, readback))
            and offline["browser"]["attemptId"] == offline["attemptId"]
            and offline["browser"]["feedbackId"] == receipt["feedbackId"],
            "the same receipt was not read back on the same original attempt")

    for key, minimum in (("https", 12), ("route", 6)):
        rows = probes[key]
        times = {utc(row["at"]) for row in rows}
        require(len(times) == len(rows) >= minimum and min(times) >= start and max(times) <= end
                and min(times) <= b_start and max(times) >= c_end
                and all(row["outcome"] == ("connection-failed" if key == "https" else "no-default-route")
                        for row in rows), f"insufficient timestamped offline {key} probes")

    soak = official["soak"]
    soak_start, soak_end = utc(soak["startedAt"]), utc(soak["endedAt"])
    wakeups = soak["wakeups"]
    require((soak_end - soak_start).total_seconds() >= 86400 and len(wakeups) >= 3
            and len({row["officialRunId"] for row in wakeups}) == len(wakeups)
            and len({utc(row["startedAt"]) for row in wakeups}) == len(wakeups)
            and all(nonempty(row["officialRunId"]) and row["source"] == "scheduled-cloud"
                    and row["automationId"] == official["automationId"] and integer(row["approvalPrompts"])
                    and row["approvalPrompts"] == 0
                    and soak_start <= utc(row["startedAt"]) < utc(row["endedAt"]) <= soak_end for row in wakeups),
            "24-hour soak needs at least three verified cloud wakeups without prompts")
    return checkpoint


def verify_checkpoint_file(path, checkpoint, offline, output):
    require(path.stat().st_size == checkpoint["bytes"], "decode checkpoint byte count does not match Work's download")
    decoded = read_checkpoint(path, input_sha256=offline["recordingSha256"],
                              artifact_sha256=checkpoint["artifactSha256"], analysis_version=offline["analysisVersion"])
    timeline = output["analysis"]["decoded"]
    require(decoded.input_bytes == offline["inputBytes"]
            and decoded.sample_rate == timeline["sampleRateHz"] and decoded.sample_count == timeline["sampleCount"],
            "the receipt does not use the recovered decode checkpoint's timeline")
    return decoded


def ranges_union(ranges, sample_count):
    merged = []
    for start, end in sorted(ranges):
        require(integer(start) and integer(end, 1) and start < end <= sample_count,
                "invalid original sample range")
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def verify_inference(analysis, predictions, labels, manifest):
    require(same(analysis, manifest, IDENTITY), "inference receipts belong to a different candidate")
    clips = {row["clipId"]: row for row in labels["clips"]}
    windows = {row["clipId"]: row for row in analysis["clips"]}
    require(len(windows) == len(analysis["clips"]) and windows.keys() == clips.keys(),
            "inference receipts must cover every sealed clip exactly once")
    for prediction in predictions["clips"]:
        clip_id = prediction["clipId"]
        label, receipt = clips[clip_id], windows[clip_id]
        samples = label["sampleCount"]
        require(receipt["audioSha256"] == prediction["audioSha256"] == label["audioSha256"]
                and receipt["sampleRateHz"] == label["sampleRateHz"] == 16000
                and receipt["sampleCount"] == samples and integer(samples, 1), "inference timeline mismatch")
        successful = []
        seen = set()
        for window in receipt["windows"]:
            index = window["chunkIndex"]
            require(integer(index) and index not in seen and window["state"] == "inferred"
                    and digest(window["outputSha256"]), "invalid completed inference window")
            seen.add(index)
            successful.append([window["startSample"], window["endSample"]])
        require(bool(successful) and ranges_union(successful, samples)
                == ranges_union(prediction["analyzedSamples"], samples),
                "claimed coverage differs from completed inference windows")


def verify_offline_inference(evidence, offline, run, checkpoint, decoded, output, hashes):
    receipt = offline["feedbackReceipt"]
    require(same(evidence, offline, SUBJECT) and evidence["fence"] == receipt["fence"] == run["fences"][0]
            and evidence["clientRunId"] == run["clientRunId"]
            and evidence["checkpointSha256"] == checkpoint["artifactSha256"]
            and evidence["weightsSha256"] == hashes["model-weights.bin"]
            and evidence["configSha256"] == hashes["analysis-config.json"]
            and evidence["outputSha256"] == receipt["outputSha256"]
            and utc(run["checkpointVerifiedAt"]) <= utc(evidence["startedAt"])
            < utc(evidence["endedAt"]) <= utc(receipt["createdAt"]),
            "offline inference does not bind to the recovered input, model and receipt")
    samples = decoded.samples
    if sys.byteorder != "little":
        samples = samples[:]
        samples.byteswap()
    pcm = memoryview(samples).cast("B")
    seen, completed = set(), []
    for window in evidence["windows"]:
        index, start, end = (window[key] for key in ("chunkIndex", "startSample", "endSample"))
        require(integer(index) and index not in seen and integer(start) and integer(end, 1)
                and start < end <= decoded.sample_count and window["state"] == "inferred",
                "invalid completed offline inference window")
        seen.add(index)
        require(window["inputPcmSha256"] == hashlib.sha256(pcm[start * 2:end * 2]).hexdigest(),
                "offline inference window does not match recovered PCM samples")
        require(nonempty(window.get("outputBase64")), "missing offline inference window artifact")
        raw = base64.b64decode(window["outputBase64"], validate=True)
        require(window["outputSha256"] == hashlib.sha256(raw).hexdigest(),
                "offline inference window artifact digest does not match")
        artifact = read_json(raw)
        require(same(artifact, window, ("chunkIndex", "startSample", "endSample", "inputPcmSha256"))
                and isinstance(artifact.get("result"), dict) and bool(artifact["result"]),
                "offline inference artifact has no model result for this window")
        completed.append([start, end])
    require(ranges_union(completed, decoded.sample_count) == [[0, decoded.sample_count]]
            and ranges_union(output["analysis"]["coverage"]["analyzedSamples"], decoded.sample_count)
            == [[0, decoded.sample_count]], "offline inference artifacts do not cover the complete recovered audio")


def error_time_keys(kind):
    return ("anchorMs",) if kind == "deletion" else ("startMs", "endMs")


def within_media_time(value, duration_ms):
    return type(value) in (int, float) and 0 <= value <= duration_ms


def verify_offline_output(output, reference, offline, output_sha):
    receipt = offline["feedbackReceipt"]
    require(receipt["outputSha256"] == output_sha and same(reference, offline, SUBJECT)
            and nonempty(reference["reviewerId"]), "offline output or human reference does not bind to this receipt")
    analysis = output["analysis"]
    decoded = analysis["decoded"]
    require(analysis["state"] == "completed" and analysis["schemaVersion"] == 1
            and analysis["inputSha256"] == offline["recordingSha256"]
            and analysis["analysisVersion"] == offline["analysisVersion"]
            and decoded["sampleRateHz"] == 16000 and integer(decoded["sampleCount"], 480_000)
            and decoded["sampleCount"] <= 2_880_000
            and ranges_union(analysis["coverage"]["analyzedSamples"], decoded["sampleCount"])
            == [[0, decoded["sampleCount"]]], "receipt does not contain full-length acoustic analysis")
    duration_ms = decoded["sampleCount"] / 16

    def correct_time(event, human, key):
        actual, expected = event[key], human[key]
        return all(within_media_time(value, duration_ms) for value in (actual, expected)) \
            and abs(actual - expected) <= 150

    playback = offline["browser"]["playback"]
    require(playback["recordingId"] == offline["recordingId"] and integer(playback["startMs"]),
            "offline playback does not identify the original recording and seek point")
    for event in analysis["errors"]:
        for human in reference["errors"]:
            if (same(event, human, ERROR_ID) and human["kind"] in ("substitution", "addition", "deletion")
                    and event[error_time_keys(human["kind"])[0]] == playback["startMs"]
                    and all(correct_time(event, human, key) for key in error_time_keys(human["kind"]))):
                return event, human
    raise ValueError("offline playback has no independently verified error at its seek timestamp")


def verify_playback_events(events, start_ms, stop_ms, duration_ms, *, require_metadata=False):
    playback = []
    metadata = None
    previous = -1
    for event in events:
        require(within_media_time(event["mediaTimeMs"], duration_ms) and integer(event["elapsedMs"])
                and event["elapsedMs"] >= previous,
                "invalid browser media event timestamp")
        previous = event["elapsedMs"]
        if event["type"] == "loadedmetadata" and metadata is None:
            metadata = event["elapsedMs"]
        if event["type"] in ("seeked", "playing", "pause", "ended"):
            playback.append(event)
    for seeked, playing, stopped in zip(playback, playback[1:], playback[2:]):
        if (seeked["type"] == "seeked" and playing["type"] == "playing"
                and stopped["type"] in ("pause", "ended")):
            require((not require_metadata or metadata is not None and metadata <= seeked["elapsedMs"])
                    and seeked["elapsedMs"] <= playing["elapsedMs"] < stopped["elapsedMs"]
                    and abs(seeked["mediaTimeMs"] - start_ms) <= 150
                    and abs(playing["mediaTimeMs"] - start_ms) <= 150
                    and abs(stopped["mediaTimeMs"] - stop_ms) <= 150
                    and stopped["mediaTimeMs"] > playing["mediaTimeMs"],
                    "browser seek or playback stop does not match the independently verified time")
            return
    raise ValueError("missing browser seeked, playing and stop event sequence")


def verify_browser_playback(raw, browser, offline, event, human, duration_ms, *,
                            browsers=("Chrome", "Safari"), timeline_encodings=None, require_metadata=False):
    receipt = offline["feedbackReceipt"]
    start = max(0, event["anchorMs"] - 750) if event["kind"] == "deletion" else max(0, event["startMs"] - 500)
    end = event["anchorMs"] + 750 if event["kind"] == "deletion" else event["endMs"] + 500
    stop = min(duration_ms, max(start + 300, end))
    require(nonempty(human.get("word")), "offline human reference needs the word heard on playback")
    for name in browsers:
        review = raw["reviews"][name]
        require(same(review, offline, SUBJECT) and review["feedbackId"] == receipt["feedbackId"]
                and review["receiptId"] == receipt["id"] and review["version"] == browser["browsers"][name]["version"]
                and same(review["error"], event, ERROR_ID + error_time_keys(event["kind"])),
                f"{name} playback does not bind to the original answer and error receipt")
        require(nonempty(review["reviewerId"]) and review["heardWord"] == human["word"]
                and review["heardActual"] == human["actual"],
                f"{name} playback has no matching human listening record")
        verify_playback_events(review["events"], start, stop, duration_ms, require_metadata=require_metadata)

    samples = raw["timelineChecks"]
    expected = timeline_encodings or {("Chrome", "webm/opus"), ("Safari", "mp4/aac")}
    require(len(samples) == len(expected) and {(row["browser"], row["encoding"]) for row in samples} == expected,
            "missing browser timeline markers for both recording encodings")
    require(len({sample["recordingSha256"] for sample in samples}) == len(samples),
            "timeline markers must come from distinct original recordings")
    for sample in samples:
        duration = sample["durationMs"]
        markers = sample["markers"]
        require(integer(duration, 30_000) and duration <= 180_000
                and digest(sample["recordingSha256"]) and sample["recordingSha256"] != offline["recordingSha256"]
                and sample["version"] == browser["browsers"][sample["browser"]]["version"]
                and [marker["position"] for marker in markers] == ["first", "middle", "tail"],
                "invalid independent first, middle and tail timeline markers")
        for index, marker in enumerate(markers):
            start, stop = marker["startMs"], marker["stopMs"]
            require(within_media_time(start, duration) and within_media_time(stop, duration)
                    and index * duration / 3 <= start < (index + 1) * duration / 3 and start < stop,
                    "browser marker is outside its expected portion of the original recording")
            verify_playback_events(marker["events"], start, stop, duration, require_metadata=require_metadata)


def replay_report(legacy_dir, script, inputs, expected):
    result = subprocess.run(
        [sys.executable, str(legacy_dir / script), *map(str, inputs)], capture_output=True, check=False,
    )
    require(result.returncode == 0 and read_json(result.stdout) == expected,
            f"{script} did not reproduce the signed report")


def verify_platform_probes(evidence, offline, history_sha256):
    probes = evidence["probes"]
    duration_ranges = {"short": (30_000, 45_000), "near-limit": (165_000, 180_000)}
    expected = {(encoding, span) for encoding in ("webm/opus", "mp4/aac") for span in duration_ranges}
    require(evidence["officialHistorySha256"] == history_sha256
            and len(probes) == len(expected) and {(row["encoding"], row["span"]) for row in probes} == expected,
            "G0 needs verified short and near-limit cloud audio probes for both browser encodings")
    recordings = {offline["recordingSha256"]}
    task_ids = {offline["taskId"]}
    offline_run_ids = {run["officialRunId"] for run in offline["runs"]}
    probe_runs = {}
    run_identity = ("automationId", "startedAt", "endedAt", "quotaObservation")
    for row in probes:
        minimum, maximum = duration_ranges[row["span"]]
        require(integer(row["durationMs"], minimum) and row["durationMs"] <= maximum
                and nonempty(row["taskId"]) and row["taskId"] not in task_ids
                and digest(row["recordingSha256"]) and row["recordingSha256"] not in recordings
                and integer(row["recordingBytes"], 1) and row["recordingBytes"] <= 12 * 1024 * 1024,
                "invalid or reused G0 recording or task")
        task_ids.add(row["taskId"])
        recordings.add(row["recordingSha256"])
        read, resume = row["readRun"], row["resumeRun"]
        for run in (read, resume):
            run_id = run["officialRunId"]
            require(nonempty(run_id) and run_id not in offline_run_ids
                    and run["taskId"] == row["taskId"] and run["source"] == "scheduled-cloud"
                    and nonempty(run["automationId"]) and integer(run["fence"], 1)
                    and integer(run["approvalPrompts"]) and run["approvalPrompts"] == 0
                    and 0 < (utc(run["endedAt"]) - utc(run["startedAt"])).total_seconds() <= 900
                    and nonempty(run["quotaObservation"])
                    and same(run, probe_runs.setdefault(run_id, run), run_identity),
                    "G0 run lacks an independent cloud record, elapsed time or quota observation")
        require(read["officialRunId"] != resume["officialRunId"]
                and read["automationId"] == resume["automationId"] and read["fence"] < resume["fence"]
                and utc(read["endedAt"]) <= utc(resume["startedAt"])
                and read["readBytes"] == row["recordingBytes"] and read["computedSha256"] == row["recordingSha256"]
                and read["decoderInputSha256"] == row["recordingSha256"]
                and digest(read["checkpointSha256"]) and integer(read["checkpointBytes"], 1)
                and same(resume, read, ("checkpointSha256", "checkpointBytes"))
                and resume["computedCheckpointSha256"] == read["checkpointSha256"],
                "G0 did not deliver the full original to the decoder and read back the checkpoint")
        faults = row["faults"]
        require(integer(faults["shortReadBytes"]) and faults["shortReadBytes"] < row["recordingBytes"]
                and faults["shortReadRejected"] is True and faults["recoveredSha256"] == row["recordingSha256"]
                and faults["expiredRejected"] is True and faults["refreshedSucceeded"] is True,
                "G0 needs truncated transfer recovery and expired access refresh")
    receipt = evidence["receiptProbe"]
    require(receipt["officialRunId"] in probe_runs and receipt["kind"] == "writing"
            and nonempty(receipt["taskId"]) and receipt["taskId"] not in task_ids
            and nonempty(receipt["receiptId"]) and receipt["receiptId"] == receipt["readbackReceiptId"],
            "G0 needs an isolated text write and receipt readback on the same cloud connection")


def stratified_score(inventory, labels, predictions, scorer):
    references = scorer["clips_by_id"](labels)
    outputs = scorer["clips_by_id"](predictions)
    groups = {"byDevice": {}, "byEncoding": {}, "byCondition": {}}
    for clip in inventory["clips"]:
        clip_id, device = clip["clipId"], clip["deviceClass"]
        require(nonempty(device) and bool(clip["conditions"]), "holdout clip is missing its device or conditions")
        label = references[clip_id]
        counts, deviations, effective, covered = scorer["count_errors"](label, outputs[clip_id])
        row = (label["speakerId"], scorer["sum_counts"](counts.values()), deviations, effective, covered)
        groups["byDevice"].setdefault(device, []).append(row)
        encoding = f"{clip['container']}/{clip['codec']}"
        groups["byEncoding"].setdefault(encoding, []).append(row)
        for condition in set(clip["conditions"]):
            groups["byCondition"].setdefault(condition, []).append(row)

    def summarize(rows):
        speakers, counts, times, effective, covered = zip(*rows, strict=True)
        deviations = sorted(value for clip in times for value in clip)
        return {
            "clips": len(rows), "speakers": len(set(speakers)),
            "metrics": scorer["metrics"](scorer["sum_counts"](counts)),
            "effectiveSeconds": sum(effective), "analyzedSeconds": sum(covered),
            "timingMs": {"median": median(deviations), "p95": scorer["quantile"](deviations, .95),
                         "max": max(deviations)} if deviations else None,
        }

    return {axis: {key: summarize(rows) for key, rows in grouped.items()} for axis, grouped in groups.items()}


def verify_holdout(bundle, docs, manifest, legacy_dir, recording_root, frozen_files=()):
    hashes = manifest["files"]
    ledger = docs["holdout-ledger.json"]
    require(all(ledger["files"].get(name) == hashes[name] for name in (
        "holdout-inventory.json", "annotator-a.json", "annotator-b.json", "adjudicated.json",
        "predictions.json", "aligned-predictions.json", "word-map.json", "reference-words.json",
        "preflight.json", "score.json", "stratified-score.json", "analysis-bundle.tar.zst", "inference-windows.json",
        "model-weights.bin", "analysis-config.json", *frozen_files,
    )), "sealed holdout ledger does not bind the labels, predictions and scoring to the frozen analyzer")
    people = [ledger[name] for name in ("annotatorA", "annotatorB", "adjudicator")]
    require(len(set(people)) == 3 and all(nonempty(person) for person in people)
            and people == [docs[name]["reviewerId"] for name in ("annotator-a.json", "annotator-b.json", "adjudicated.json")]
            and utc(ledger["labelsSealedAt"]) < utc(ledger["predictionsSealedAt"])
            and ledger["independentBlindAnnotations"] is True and ledger["consentVerified"] is True
            and ledger["speakerSplitVerified"] is True, "holdout provenance is incomplete")
    reference = docs["reference-words.json"]
    require(reference["rulesSha256"] == docs["holdout-inventory.json"]["rulesSha256"],
            "reference transcript uses different sealed word rules")
    aligned, mapping = align(reference, docs["predictions.json"])
    require(aligned == docs["aligned-predictions.json"] and mapping == docs["word-map.json"],
            "blind word alignment did not reproduce the sealed prediction indexes")
    verify_inference(docs["inference-windows.json"], aligned, docs["adjudicated.json"], manifest)
    replay_report(legacy_dir, "validate_holdout.py",
                  [bundle / name for name in ("holdout-inventory.json", "annotator-a.json",
                                             "annotator-b.json", "adjudicated.json")] + [recording_root],
                  docs["preflight.json"])
    replay_report(legacy_dir, "score_pronunciation.py",
                  [bundle / "adjudicated.json", bundle / "aligned-predictions.json"], docs["score.json"])
    scorer = runpy.run_path(str(legacy_dir / "score_pronunciation.py"))
    require(stratified_score(docs["holdout-inventory.json"], docs["adjudicated.json"], aligned, scorer)
            == docs["stratified-score.json"], "sealed device, encoding or condition scores did not reproduce")


def verify_bundle(bundle, trusted_signers, legacy_dir, repo, recording_root):
    raw = local_file(bundle, "manifest.json").read_bytes()
    verify_signatures(bundle, raw, trusted_signers)
    manifest = read_json(raw)
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 2 and manifest["route"] == "A"
            and digest(manifest["sourceSha"], 40) and digest(manifest["buildSha256"])
            and nonempty(manifest["environmentId"]) and nonempty(manifest["analysisVersion"]),
            "invalid release manifest identity")
    hashes = manifest["files"]
    require(set(hashes) == set(FILES) and hashes["site-build.tar.gz"] == manifest["buildSha256"],
            "manifest file list or build digest does not match")
    docs = {}
    for name in FILES:
        path = local_file(bundle, name)
        with path.open("rb") as data:
            require(hashlib.file_digest(data, "sha256").hexdigest() == hashes[name], f"digest mismatch for {name}")
        if name.endswith(".json"):
            docs[name] = read_json(path.read_bytes())
    for name in ("candidate.json", "gates.json", "holdout-ledger.json", "offline.json", "work-runs.json",
                 "mac-probes.json", "platform-probe.json", "browser-acceptance.json", "browser-playback-events.json",
                 "offline-inference.json"):
        require(same(docs[name], manifest, IDENTITY), f"{name} belongs to a different candidate")
    verify_holdout(bundle, docs, manifest, legacy_dir, recording_root)

    offline = docs["offline.json"]
    runs = docs["work-runs.json"]
    checkpoint = verify_work_runs(offline, runs, docs["mac-probes.json"])
    require(docs["site-event-export.json"]["events"] == offline["beforeOfflineEvents"] + offline["serverEvents"]
            and docs["site-event-export.json"]["feedbackReceipt"] == offline["feedbackReceipt"]
            and runs["officialHistorySha256"] == hashes["official-run-history.zip"],
            "official history or isolated server export does not corroborate the accepted run")
    output = docs["offline-output.json"]
    event, human = verify_offline_output(output, docs["offline-reference.json"], offline, hashes["offline-output.json"])
    decoded = verify_checkpoint_file(bundle / "offline-checkpoint.bin", checkpoint, offline, output)
    verify_offline_inference(docs["offline-inference.json"], offline, runs["runs"][2], checkpoint, decoded, output, hashes)
    verify_platform_probes(docs["platform-probe.json"], offline, hashes["official-run-history.zip"])
    browser = docs["browser-acceptance.json"]
    require(same(browser, offline, SUBJECT) and browser["feedbackId"] == offline["feedbackReceipt"]["feedbackId"]
            and browser["receiptId"] == offline["feedbackReceipt"]["id"], "G4 does not point to the G3 original attempt")
    for name in ("Chrome", "Safari"):
        record = browser["browsers"][name]
        require(nonempty(record["version"]) and record["realMicrophone"] is True
                and integer(record["durationMs"], 30_000) and record["durationMs"] <= 180_000
                and all(record["cases"].get(case) is True for case in BROWSER_CASES),
                f"missing isolated browser evidence for {name}")
    before, after = browser["learnerBaselineBefore"], browser["learnerBaselineAfter"]
    require(PRESERVED <= before.keys() and before == after and browser["rollbackVerified"] is True,
            "isolated historical state or rollback has not been verified")
    verify_browser_playback(docs["browser-playback-events.json"], browser, offline, event, human,
                            decoded.decoded_duration_ms)

    arguments = [
        "--candidate", "candidate.json", "--preflight", "preflight.json", "--score", "score.json",
        "--offline", "offline.json", "--gates", "gates.json", "--zero-cost", "zero-cost.json",
    ]
    result = subprocess.run(
        [sys.executable, str(legacy_dir / "release_guard.py"), "--repo", str(repo), "--json",
         *[str(bundle / value) if value.endswith(".json") else value for value in arguments]],
        capture_output=True, text=True, check=False,
    )
    require(result.returncode == 0, "legacy zero-cost release check failed: " + (result.stdout or result.stderr).strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--trusted-signers", type=Path, required=True)
    parser.add_argument("--legacy-dir", type=Path, required=True, help="trusted historical delivery tools")
    parser.add_argument("--recordings", type=Path, required=True, help="consented private holdout originals")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        verify_bundle(args.evidence.resolve(), args.trusted_signers.resolve(), args.legacy_dir.resolve(),
                      args.repo.resolve(), args.recordings.resolve())
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        parser.exit(1, f"BLOCKED: {error}\n")
    print("READY: signed Route A evidence and historical zero-cost guard passed.")


if __name__ == "__main__":
    main()
