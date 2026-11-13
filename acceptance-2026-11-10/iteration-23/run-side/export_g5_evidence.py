#!/usr/bin/env python3
"""G5 evidence export for Bandroom protocol bandroom-d2-cloud-recovery-v1 (route A).

Maps v26 A/B/C run outputs plus the read-only cold reference run D to the signed
bundle: 32 regular evidence files + acoustic-NN.bin + manifest.json.

Two rules drive this file:

1. acoustic-NN.bin follows the verifier's own plan, not the v26 prefix.
   verify_cloud_release.verify_acoustic() reconstructs:
       plan = list(windows(decoded.sample_count))
   using bandroom_acoustic.acoustic_stage: 320-sample frames, 400-sample
   receptive field, 800-frame windows, offsets (0, 400), 100-frame context.
   For the HJK original that is 10 transfer chunks, not the 6 v26 prefix parts.
   This exporter recomputes that plan, validates every chunk header/digest/
   predecessor, and refuses to relabel v26 prefix files as acoustic chunks.

2. site-event-export.json contains exactly the 9 cloud event types and 11 rows
   the verifier expects. read_qa_site_events also returns offline_run audit rows
   and wake/drain rows; those are filtered out (offline_run feeds offline.json,
   wake rows feed emptyQueueWakes).

Expected run directory (UTF-8 JSON):

  run/
    identity.json                 sourceSha, sourceTreeSha, buildSha256,
                                  runtimeBundleSha256, modelWeightsSha256,
                                  configSha256, analysisVersion, environmentId,
                                  route ("A")
    runs/a.json b.json c.json d.json
                                  server reports: runId, fence, startedAt,
                                  endedAt, automationId, nextIndex, prefix/output
                                  SHAs, official refs, confirmations=0
    official/run-history.json     platform export for A/B/C + cold D
    official/wake-runs.json       [{at, officialRunId, officialRecordRef, ...}]
    official/page.json            close/reopen receipts
    official/fairness.json        queue fairness readback
    site/site-events.json         raw read_qa_site_events export (all kinds)
    executor/runs.json            [B, C, D] cloud-executor receipts
    acoustic/checkpoint-0.json    B v26 prefix metadata (kept for the v26 branch)
    acoustic/checkpoint-1.bin … checkpoint-6.bin
    acoustic/checkpoint-7.json    C output manifest (outputIndex=7)
    acoustic/offline-checkpoint.bin   bandroom-decode-v1 checkpoint (run D)
    acoustic/plan.json            verifier-plan chunks/prefix/resumed/cold/logits
    acoustic/acoustic-00.bin …    transfer chunks in the verifier plan
    acoustic/cold-output.f32le    v26 859-window cold output (byte comparison)
    acoustic/resumed-output.f32le v26 859-window resumed output
    browser/browser-acceptance.json
    browser/browser-playback-events.json
    platform/platform-probe.json
    platform/runtime-profile.json
    release/gates.json zero-cost.json runtime-bundle.zip
    static/<name>                 remaining artifacts copied verbatim

  python3 export_g5_evidence.py --check <evidence-dir>
  python3 export_g5_evidence.py --build --run-dir <run> --out <evidence> \
      --static-dir <static>

--build never signs and never fabricates platform or server rows. Missing inputs
raise. Signing is a separate four-role operation with keys outside the bundle.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import struct
import sys
from hashlib import file_digest, sha256
from pathlib import Path

NAMESPACE = "bandroom-d2-cloud-recovery-v1"
ROUTE = "A"

FILES = (
    "site-build.tar.gz", "analysis-bundle.tar.zst", "model-weights.bin", "analysis-config.json",
    "zero-cost.json", "gates.json", "preflight.json", "score.json", "stratified-score.json",
    "holdout-inventory.json", "annotator-a.json", "annotator-b.json", "adjudicated.json",
    "predictions.json", "aligned-predictions.json", "word-map.json", "reference-words.json",
    "holdout-ledger.json", "inference-windows.json", "offline.json", "platform-probe.json",
    "browser-acceptance.json", "site-event-export.json", "offline-checkpoint.bin",
    "offline-output.json", "browser-playback-events.json", "runtime-bundle.zip",
    "runtime-profile.json", "official-run-history.json", "executor-event-export.json",
    "acoustic-recovery.json", "offline-cold-output.json",
)
ROLES = ("release-owner", "holdout-custodian", "work-auditor", "site-auditor")

WORK_EVENTS = (
    ("A", ("claimed", "retry_wait")),
    ("B", ("claimed", "recording_verified", "checkpoint_saved", "interrupted")),
    ("C", ("claimed", "checkpoint_restored", "suffix_completed", "feedback_committed", "receipt_readback")),
)
CLOUD_EVENT_TYPES = frozenset(t for _, types in WORK_EVENTS for t in types)
SUBJECT = ("jobId", "taskId", "attemptId", "attemptRevision", "recordingId",
           "recordingSha256", "inputBytes", "analysisVersion")
CANDIDATE = ("sourceSha", "buildSha256", "analysisVersion", "environmentId", "route",
             "sourceTreeSha", "runtimeBundleSha256", "modelWeightsSha256", "configSha256")

# bandroom_acoustic.acoustic_stage constants.
FRAME_SAMPLES = 320
RECEPTIVE_SAMPLES = 400
FRAMES_PER_WINDOW = 800
CONTEXT_FRAMES = 100
PASS_OFFSETS = (0, 400)
FEATURES = 768
PHONES = 49
TRANSFER_FORMAT = "bandroom-acoustic-chunk-v1"
FEATURE_FORMAT = "bandroom-acoustic-features-v1"
MAX_TRANSFER_HEADER = 4096
MAX_SAMPLES = 6 * 1024 * 1024
MAX_ACOUSTIC_CHUNKS = 24

DIGEST = re.compile(r"[0-9a-f]{64}")
SHA40 = re.compile(r"[0-9a-f]{40}")
ACOUSTIC = re.compile(r"acoustic-(\d{2})\.bin")


class Blocked(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Blocked(message)


def read_json(path: Path) -> dict:
    require(path.is_file(), f"missing input {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def sha_file(path: Path) -> str:
    with path.open("rb") as source:
        return file_digest(source, "sha256").hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def has_fields(value: dict, fields: tuple[str, ...], label: str) -> None:
    missing = [field for field in fields if field not in value]
    require(not missing, f"{label} missing fields: {', '.join(missing)}")


# --------------------------------------------------------------------------
# Verifier acoustic plan (bandroom_acoustic.acoustic_stage.windows)
# --------------------------------------------------------------------------

def plan_windows(sample_count: int) -> list[dict]:
    total = (sample_count - RECEPTIVE_SAMPLES) // FRAME_SAMPLES + 1
    require(total >= 1, "acoustic plan needs at least 25 ms of PCM")
    rows = []
    for offset in PASS_OFFSETS:
        first = offset - FRAMES_PER_WINDOW if offset else 0
        for start_frame in range(first, total, FRAMES_PER_WINDOW):
            start = max(0, start_frame)
            end = min(total, start_frame + FRAMES_PER_WINDOW)
            rows.append({
                "offset": offset,
                "start_frame": start,
                "end_frame": end,
                "left_context": max(0, start - CONTEXT_FRAMES),
                "right_context": min(total, end + CONTEXT_FRAMES),
            })
    return rows


def window_bytes(window: dict) -> int:
    return (window["end_frame"] - window["start_frame"]) * FEATURES * 4


def encode_transfer_chunk(identity: dict, index: int, previous: str, raw: bytes) -> bytes:
    header = canonical({
        "format": TRANSFER_FORMAT, "chunkIndex": index, "previousSha256": previous,
        "decodeSha256": identity["decodeSha256"], "bundleSha256": identity["bundleSha256"],
        "configSha256": identity["configSha256"], "featuresSha256": sha256(raw).hexdigest(),
    })
    return struct.pack(">I", len(header)) + header + raw


def read_transfer_chunk(path: Path, digest: str, identity: dict, index: int, previous: str, size: int) -> bytes:
    require(path.is_file(), f"missing transfer chunk {path.name}")
    limit = 4 + MAX_TRANSFER_HEADER + size
    value = path.read_bytes()
    require(len(value) <= limit and len(value) > 4 + size,
            f"acoustic transfer chunk {index} has an invalid length")
    require(sha256(value).hexdigest() == digest, f"acoustic transfer chunk {index} digest differs")
    header_length = struct.unpack_from(">I", value)[0]
    raw = value[4 + header_length:]
    require(len(raw) == size, f"acoustic transfer chunk {index} payload size differs")
    require(value == encode_transfer_chunk(identity, index, previous, raw),
            f"acoustic transfer chunk {index} header/identity/predecessor differs")
    return raw


def acoustic_manifest(identity: dict, plan: list[dict], chunks: list[dict]) -> bytes:
    header = {
        "format": FEATURE_FORMAT,
        "identity": identity,
        "plan": [
            {"offset": row["offset"], "start_frame": row["start_frame"], "end_frame": row["end_frame"],
             "left_context": row["left_context"], "right_context": row["right_context"]}
            for row in plan
        ],
    }
    return canonical({**header, "chunks": chunks, "nextChunk": len(chunks)})


# --------------------------------------------------------------------------
# bandroom-decode-v1 checkpoint (enough to derive the plan and the decode digest)
# --------------------------------------------------------------------------

MAX_CHECKPOINT_MANIFEST = 4096


def read_checkpoint_summary(path: Path) -> dict:
    require(path.is_file(), f"missing checkpoint {path.name}")
    value = path.read_bytes()
    require(len(value) > 7, "checkpoint is too short")
    length = struct.unpack_from(">I", value)[0]
    require(0 < length <= MAX_CHECKPOINT_MANIFEST and 4 + length < len(value),
            "checkpoint manifest length is invalid")
    manifest = json.loads(value[4:4 + length].decode("utf-8"))
    require(isinstance(manifest, dict), "checkpoint manifest is not an object")
    require(manifest.get("format") == "bandroom-decode-v1", "checkpoint format is not bandroom-decode-v1")
    pcm = manifest.get("pcm") or {}
    require(pcm.get("encoding") == "s16le" and pcm.get("rateHz") == 16_000 and pcm.get("channels") == 1,
            "checkpoint PCM is not 16 kHz mono s16le")
    count = pcm.get("sampleCount")
    require(type(count) is int and 0 < count <= MAX_SAMPLES, "checkpoint sample count is invalid")
    raw = memoryview(value)[4 + length:]
    require(len(raw) == 2 * count, "checkpoint PCM length differs from sampleCount")
    require(sha256(raw).hexdigest() == pcm.get("sha256"), "checkpoint PCM digest differs")
    return {
        "sampleCount": count,
        "inputSha256": manifest.get("inputSha256"),
        "inputBytes": manifest.get("inputBytes"),
        "analysisVersion": manifest.get("analysisVersion"),
        "pcmSha256": pcm.get("sha256"),
        "artifactSha256": sha256(value).hexdigest(),
    }


# --------------------------------------------------------------------------
# Composition
# --------------------------------------------------------------------------

def run_report(run: Path, step: str) -> dict:
    report = read_json(run / "runs" / f"{step.lower()}.json")
    require(report.get("step") == step, f"run report {step} has the wrong step")
    return report


def compose_offline(run: Path, identity: dict, history: dict, site_raw: list[dict]) -> dict:
    a, b, c, d = (run_report(run, step) for step in ("A", "B", "C", "D"))
    for report in (a, b, c):
        has_fields(report, ("officialRunId", "runId", "fence", "startedAt", "endedAt",
                            "automationId", *SUBJECT), f"run {report['step']}")
        require(report["automationId"] == history["automationId"],
                f"run {report['step']} automationId differs from the history")
    require(isinstance(d.get("officialRunId"), str) and d["officialRunId"],
            "run D must carry its own officialRunId")
    require(d["officialRunId"] not in {a["officialRunId"], b["officialRunId"], c["officialRunId"]},
            "run D officialRunId must be distinct from A/B/C")
    require(c.get("coldOutputSha256") == c.get("resumedOutputSha256"), "C cold != resumed")
    require(c.get("duplicateFeedbackCount") == 1, "C must record exactly one duplicate feedback")
    receipt = c["feedbackReceipt"]
    has_fields(receipt, ("jobId", "taskId", "attemptId", "attemptRevision", "recordingId",
                         "recordingSha256", "inputBytes", "analysisVersion", "fence", "id",
                         "feedbackId", "outputSha256"), "feedback receipt")
    require(receipt["fence"] == c["fence"], "receipt fence differs from C")

    # The new server audit rows are the offline_run records; they must agree.
    audits = [row for row in site_raw if row.get("type") == "offline_run"]
    for report in (a, b, c):
        row = next((item for item in audits
                    if item.get("officialRunId") == report["officialRunId"]
                    and item.get("fence") == report["fence"]), None)
        require(row is not None, f"missing offline_run audit row for {report['step']}")
        require(row.get("automationId") == report["automationId"] and row.get("isolated") is True,
                f"offline_run audit row for {report['step']} lacks automationId/isolated")

    return {
        **{key: identity[key] for key in CANDIDATE if key in identity},
        **{key: c[key] for key in SUBJECT if key in c},
        "automationId": history["automationId"],
        "isolated": True,
        "runs": [a, b, c],
        "coldRunId": d["officialRunId"],
        "page": read_json(run / "official" / "page.json"),
        "feedbackReceipt": receipt,
        "jobState": c["jobState"],
        "duplicateFeedbackCount": c["duplicateFeedbackCount"],
        "feedbackVisible": c["feedbackVisible"],
        "fairness": read_json(run / "official" / "fairness.json"),
    }


def compose_history(run: Path, site_raw: list[dict]) -> dict:
    history = read_json(run / "official" / "run-history.json")
    require(bool(history.get("automationId")), "history lacks automationId")
    runs = history.get("runs", [])
    require(len(runs) >= 4, "history needs A/B/C plus a distinct cold run")
    ids = [row.get("officialRunId") for row in runs]
    require(len(set(ids)) == len(ids), "history run ids must be distinct")
    for row in runs:
        has_fields(row, ("officialRunId", "startedAt", "endedAt", "automationId", "taskId",
                         "officialRecordRef", "source", "clientExecution", "approvalPrompts",
                         "quotaObservation"), "history run")
        require(row["automationId"] == history["automationId"], "history run automationId differs")
        require(row["source"] == "scheduled-cloud" and row["clientExecution"] is False,
                "history run is not an unattended scheduled-cloud run")
        require(row["approvalPrompts"] == 0, "history run recorded approval prompts")

    # emptyQueueWakes come from the append-only wake rows, mapped to platform records.
    mapping = read_json(run / "official" / "wake-runs.json").get("wakes", [])
    by_at = {row["at"]: row for row in mapping}
    wakes = []
    for row in site_raw:
        if row.get("kind") != "wake":
            continue
        require(row.get("emptyQueueAccepted") is True, "a wake row was not accepted as empty")
        require(row.get("subscriptionActive") is True, "a wake row lacks an active subscription")
        require(row.get("pendingCount") == 0 and row.get("pendingAcoustics") == 0,
                "a wake row has pending work")
        record = by_at.get(row.get("at"))
        require(record is not None, f"wake at {row.get('at')} has no platform record mapping")
        wakes.append({
            "officialRunId": record["officialRunId"],
            "officialRecordRef": record["officialRecordRef"],
            "automationId": history["automationId"],
            "source": "scheduled-cloud",
            "clientExecution": False,
            "approvalPrompts": 0,
            "discoveredCount": 0,
            "createdCount": 0,
            "startedAt": record.get("startedAt") or row.get("utc"),
        })
    require(len({row["officialRunId"] for row in wakes}) == len(wakes) >= 3,
            "need at least three distinct empty-queue official wakes")
    stamps = [row["startedAt"] for row in wakes]
    require(stamps == sorted(stamps), "empty-queue wakes are not chronological")
    from datetime import datetime
    span = (datetime.fromisoformat(stamps[-1].replace("Z", "+00:00"))
            - datetime.fromisoformat(stamps[0].replace("Z", "+00:00"))).total_seconds()
    require(span >= 86_400, "empty-queue wakes span less than 24 hours")
    history = {**history, "emptyQueueWakes": wakes}
    return history


def compose_site(site_raw: list[dict], offline: dict) -> dict:
    cloud = [row for row in site_raw if row.get("type") in CLOUD_EVENT_TYPES]
    require(len(cloud) == 11, f"site export needs exactly 11 cloud events, got {len(cloud)}")
    require(all(row.get("source") == "cloud" for row in cloud), "a G5 event is not source=cloud")
    by_step = {row["step"]: row["officialRunId"] for row in offline["runs"]}
    for step, expected in WORK_EVENTS:
        observed = [row["type"] for row in cloud if row.get("officialRunId") == by_step[step]]
        require(tuple(observed) == expected, f"site event order for {step} is {observed}")
    for row in cloud:
        has_fields(row, ("officialRunId", "fence", "utc", *SUBJECT), "site event")
        row["at"] = row["utc"]
    verified = next(row for row in cloud if row["type"] == "recording_verified")
    require(verified.get("bytes") == offline["inputBytes"],
            "recording_verified.bytes differs from offline.inputBytes")
    require(verified.get("sha256") == offline["recordingSha256"],
            "recording_verified.sha256 differs from offline.recordingSha256")
    require(next(row for row in cloud if row["type"] == "feedback_committed").get("responseLost") is True,
            "feedback_committed must record responseLost=true")
    require(offline["page"]["browser"] == "Chrome", "page browser must be Chrome")
    return {
        "events": cloud,
        "clientOperationsDuringClosure": [],
        "feedbackReceipt": offline["feedbackReceipt"],
    }


def acoustic_expected_identity(identity: dict, offline: dict, decode_sha: str) -> dict:
    config_document = read_json(Path(identity["_static"]) / "analysis-config.json")
    stage = config_document.get("acousticConfig")
    require(isinstance(stage, dict), "analysis-config.json lacks acousticConfig")
    require(stage.get("analysisVersion") == identity["analysisVersion"],
            "acousticConfig analysisVersion differs from the release")
    return {
        "environment": identity["environmentId"],
        "taskId": offline["taskId"],
        "attemptId": offline["attemptId"],
        "revision": offline["attemptRevision"],
        "inputSha256": offline["recordingSha256"],
        "inputBytes": offline["inputBytes"],
        "decodeSha256": decode_sha,
        "bundleSha256": identity["runtimeBundleSha256"],
        "configSha256": sha256(canonical(stage)).hexdigest(),
    }


def emit_acoustic(run: Path, out: Path, identity: dict, offline: dict, manifest_files: dict) -> dict:
    checkpoint_path = run / "acoustic" / "offline-checkpoint.bin"
    checkpoint = read_checkpoint_summary(checkpoint_path)
    require(checkpoint["inputSha256"] == offline["recordingSha256"], "checkpoint input sha differs")
    require(checkpoint["inputBytes"] == offline["inputBytes"], "checkpoint input bytes differ")
    require(checkpoint["analysisVersion"] == identity["analysisVersion"], "checkpoint analysisVersion differs")

    plan = plan_windows(checkpoint["sampleCount"])
    require(0 < len(plan) <= MAX_ACOUSTIC_CHUNKS, f"acoustic plan has {len(plan)} chunks")
    wanted = acoustic_expected_identity(identity, offline, checkpoint["artifactSha256"])
    meta = read_json(run / "acoustic" / "plan.json")
    require(meta.get("sampleCount") == checkpoint["sampleCount"], "plan.json sampleCount differs")
    require(meta.get("identity") == wanted, "plan.json acoustic identity differs from the release")
    stored_plan = meta.get("plan")
    require(stored_plan == plan, "plan.json does not match the verifier's window plan")

    previous = wanted["decodeSha256"]
    digests = []
    raw_chunks = []
    for index, window in enumerate(plan):
        path = run / "acoustic" / f"acoustic-{index:02}.bin"
        digest = sha_file(path)
        require(DIGEST.fullmatch(digest) is not None, "chunk digest is not 64 hex")
        raw = read_transfer_chunk(path, digest, wanted, index, previous, window_bytes(window))
        (out / f"acoustic-{index:02}.bin").write_bytes(path.read_bytes())
        # AcousticStore.manifest hashes the RAW payload metadata; resumed/executor
        # lists use the transfer-blob digest. Keep both.
        raw_chunks.append({"sha256": sha256(raw).hexdigest(), "bytes": len(raw)})
        digests.append(digest)
        previous = digest
    require(len(set(digests)) == len(digests), "acoustic chunk digests must be distinct")

    prefix = meta.get("prefix")
    resumed = meta.get("resumed", digests)
    cold = meta.get("cold", digests)
    cut = meta.get("cut")
    if prefix is None and cut is not None:
        require(type(cut) is int and 0 < cut < len(digests), "plan.cut must be between 1 and len(resumed)-1")
        prefix = digests[:cut]
    require(resumed == digests, "plan.resumed must equal the emitted chunk digests in order")
    require(prefix == digests[:len(prefix or [])], "plan.prefix must be a prefix of resumed")
    require(0 < len(prefix) < len(digests), "plan.prefix must be non-empty and shorter than resumed")
    require(cold == digests, "plan.cold must equal resumed")
    require(meta.get("coldRunId") == offline["coldRunId"], "plan.coldRunId differs from run D")

    expected_cut = acoustic_manifest(wanted, plan, raw_chunks[:len(prefix)])
    expected_all = acoustic_manifest(wanted, plan, raw_chunks)
    require(meta.get("coldStageIndexSha256") == sha256(expected_all).hexdigest(),
            "coldStageIndexSha256 does not reproduce from the plan and chunks")
    require(meta.get("prefixStageIndexSha256") in (None, sha256(expected_cut).hexdigest()),
            "prefixStageIndexSha256 does not reproduce")
    require(isinstance(meta.get("coldLogits"), list) and meta["coldLogits"],
            "plan.coldLogits is missing")
    logits = meta["coldLogits"]
    require([row.get("offset") for row in logits] == list(PASS_OFFSETS), "coldLogits offsets differ")
    for row in logits:
        frames = sum(window["end_frame"] - window["start_frame"]
                     for window in plan if window["offset"] == row.get("offset"))
        require(row.get("frames") == frames, "coldLogits frame count differs")
        for key in ("frameSha256", "ctcSha256", "boundarySha256"):
            require(DIGEST.fullmatch(row.get(key, "")) is not None, f"coldLogits {key} is not 64 hex")

    return {
        "checkpointSha256": checkpoint["artifactSha256"],
        "plan": plan,
        "digests": digests,
        "identity": wanted,
        "cut": len(prefix),
        "stagePrefixSha256": sha256(expected_cut).hexdigest(),
        "stageAllSha256": sha256(expected_all).hexdigest(),
        "logits": logits,
    }


def compose_executor(run: Path, offline: dict, acoustic: dict) -> dict:
    payload = read_json(run / "executor" / "runs.json")
    rows = payload.get("runs", [])
    expected_ids = [offline["runs"][1]["officialRunId"], offline["runs"][2]["officialRunId"],
                    offline["coldRunId"]]
    require([row.get("officialRunId") for row in rows] == expected_ids,
            "executor rows must be [B, C, cold D]")
    require(all(row.get("source") == "cloud-executor" and row.get("localExecution") is False
                for row in rows), "executor rows must be cloud-executor with localExecution=false")
    require(len({row.get("executionId") for row in rows}) == 3, "executor executionIds must be distinct")
    require(all(row.get("stageIndexSha256") for row in rows), "executor stageIndexSha256 is missing")

    b, c, d = rows
    cut = acoustic["cut"]
    require(b.get("savedChunks") == acoustic["digests"][:cut], "B savedChunks != acoustic prefix")
    require(c.get("restoredChunks") == acoustic["digests"][:cut], "C restoredChunks != acoustic prefix")
    require(c.get("newChunks") == acoustic["digests"][cut:], "C newChunks != acoustic suffix")
    require(b.get("stageIndexSha256") == acoustic["stagePrefixSha256"], "B stage index differs")
    require(c.get("stageIndexSha256") == acoustic["stageAllSha256"], "C stage index differs")
    require(d.get("readOnly") is True and d.get("cacheEmpty") is True and d.get("restoredChunks") == [],
            "cold executor must be read-only, cache-empty, with no restored chunks")
    require(d.get("newChunks") == acoustic["digests"], "cold newChunks != acoustic plan")
    require(d.get("stageIndexSha256") == acoustic["stageAllSha256"], "cold stage index differs")
    require(c.get("logits") == d.get("logits") == acoustic["logits"],
            "recovered and cold head outputs differ")
    for row, report in zip((b, c, d), (offline["runs"][1], offline["runs"][2], {"fence": None}), strict=True):
        require(row.get("readBytes") == offline["inputBytes"], "executor readBytes differs")
        require(row.get("decoderInputSha256") == offline["recordingSha256"], "decoder input sha differs")
    require(d.get("coldOfficialRecordRef"), "cold executor lacks its official record reference")
    return payload


def compose_recovery(acoustic: dict, offline: dict) -> dict:
    return {
        "identity": acoustic["identity"],
        "prefix": acoustic["digests"][:acoustic["cut"]],
        "resumed": acoustic["digests"],
        "cold": acoustic["digests"],
        "coldRunId": offline["coldRunId"],
        "coldStageIndexSha256": acoustic["stageAllSha256"],
        "coldLogits": acoustic["logits"],
    }


# --------------------------------------------------------------------------
# Build / check
# --------------------------------------------------------------------------

def build(run: Path, out: Path, static: Path) -> None:
    identity = read_json(run / "identity.json")
    require(identity.get("route") == ROUTE, "identity route must be A")
    require(SHA40.fullmatch(identity.get("sourceSha", "")) is not None, "sourceSha must be 40 hex")
    require(SHA40.fullmatch(identity.get("sourceTreeSha", "")) is not None, "sourceTreeSha must be 40 hex")
    for key in ("buildSha256", "runtimeBundleSha256", "modelWeightsSha256", "configSha256"):
        require(DIGEST.fullmatch(identity.get(key, "")) is not None, f"{key} must be 64 hex")
    identity = {**identity, "_static": str(static)}

    site_document = read_json(run / "site" / "site-events.json")
    site_raw = site_document.get("events", [])
    require(isinstance(site_raw, list), "site-events.json events must be a list")

    history = compose_history(run, site_raw)
    offline = compose_offline(run, identity, history, site_raw)
    site = compose_site(site_raw, offline)

    out.mkdir(parents=True, exist_ok=False)
    write_json(out / "offline.json", offline)
    write_json(out / "official-run-history.json", history)
    write_json(out / "site-event-export.json", site)

    # The checkpoint must be placed before the acoustic plan can bind its digest.
    (out / "offline-checkpoint.bin").write_bytes((run / "acoustic" / "offline-checkpoint.bin").read_bytes())
    acoustic = emit_acoustic(run, out, identity, offline, {})
    write_json(out / "acoustic-recovery.json", compose_recovery(acoustic, offline))
    write_json(out / "executor-event-export.json", compose_executor(run, offline, acoustic))

    copies = {
        "offline-output.json": run / "acoustic" / "checkpoint-7.json",
        "offline-cold-output.json": run / "acoustic" / "cold-output.json",
        "platform-probe.json": run / "platform" / "platform-probe.json",
        "runtime-profile.json": run / "platform" / "runtime-profile.json",
        "browser-acceptance.json": run / "browser" / "browser-acceptance.json",
        "browser-playback-events.json": run / "browser" / "browser-playback-events.json",
        "gates.json": run / "release" / "gates.json",
        "zero-cost.json": run / "release" / "zero-cost.json",
        "runtime-bundle.zip": run / "release" / "runtime-bundle.zip",
    }
    for name, source in copies.items():
        require(source.is_file(), f"missing {source}")
        (out / name).write_bytes(source.read_bytes())

    for name in FILES:
        if (out / name).exists():
            continue
        source = static / name
        require(source.is_file(), f"static evidence {name} is not supplied")
        (out / name).write_bytes(source.read_bytes())

    chunks = [f"acoustic-{index:02}.bin" for index in range(len(acoustic["plan"]))]
    files = {name: sha_file(out / name) for name in (*FILES, *chunks)}
    manifest = {
        "schemaVersion": 1,
        "protocol": NAMESPACE,
        "route": ROUTE,
        **{key: value for key, value in identity.items() if key != "_static"},
        "files": files,
    }
    write_json(out / "manifest.json", manifest)
    print(f"wrote {out} with {len(FILES)} regular files + {len(chunks)} acoustic plan chunks")
    print("next: four detached Ed25519 signatures over manifest.json; keys stay outside the bundle")


def check(evidence: Path, require_signatures: bool = True) -> int:
    failures: list[str] = []

    def need(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    manifest_path = evidence / "manifest.json"
    if not manifest_path.is_file():
        print("FAIL  manifest.json missing")
        return 1
    manifest = read_json(manifest_path)
    need(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1, "schemaVersion must be 1")
    need(manifest.get("protocol") == NAMESPACE, f"protocol must be {NAMESPACE}")
    need(manifest.get("route") == ROUTE, "route must be A")
    for key in ("sourceSha", "sourceTreeSha"):
        need(SHA40.fullmatch(manifest.get(key, "")) is not None, f"{key} must be 40 hex")
    for key in ("analysisVersion", "environmentId"):
        need(bool(str(manifest.get(key, "")).strip()), f"{key} must be non-empty")
    for key in ("buildSha256", "runtimeBundleSha256", "modelWeightsSha256", "configSha256"):
        need(DIGEST.fullmatch(manifest.get(key, "")) is not None, f"{key} must be 64 hex")

    recovery_path = evidence / "acoustic-recovery.json"
    if not recovery_path.is_file():
        print("FAIL  acoustic-recovery.json missing")
        return 1
    recovery = read_json(recovery_path)
    resumed = recovery.get("resumed", [])
    need(1 <= len(resumed) <= MAX_ACOUSTIC_CHUNKS, "acoustic resumed count must be 1..24")
    chunks = {f"acoustic-{index:02}.bin" for index in range(len(resumed))}

    hashes = manifest.get("files", {})
    need(set(FILES) <= set(hashes), "manifest misses regular evidence files")
    need(set(hashes) == set(FILES) | chunks,
         f"manifest file set differs: extra={sorted(set(hashes) - set(FILES) - chunks)} "
         f"missing={sorted((set(FILES) | chunks) - set(hashes))}")
    for name, key in (("site-build.tar.gz", "buildSha256"), ("runtime-bundle.zip", "runtimeBundleSha256"),
                      ("model-weights.bin", "modelWeightsSha256"),
                      ("analysis-config.json", "configSha256")):
        need(hashes.get(name) == manifest.get(key), f"{name} binding")

    for name, expected in sorted(hashes.items()):
        path = evidence / name
        if not path.is_file():
            failures.append(f"missing file {name}")
        elif sha_file(path) != expected:
            failures.append(f"digest mismatch {name}")

    offline_path = evidence / "offline.json"
    if offline_path.is_file():
        offline = read_json(offline_path)
        need(offline.get("isolated") is True, "offline.isolated must be true")
        runs = offline.get("runs", [])
        need(len(runs) == 3 and [row.get("step") for row in runs] == ["A", "B", "C"],
             "offline.runs must be exactly A/B/C")
        need(all(row.get("automationId") == offline.get("automationId") for row in runs),
             "offline run automationId differs")
        need(all(type(row.get("fence")) is int and row["fence"] >= 1 for row in runs),
             "offline fences must be positive integers")
        need(len({row.get("officialRunId") for row in runs}) == 3, "offline run ids must be distinct")
        need(offline.get("coldRunId") not in {row.get("officialRunId") for row in runs},
             "coldRunId must be distinct from A/B/C")

    site_path = evidence / "site-event-export.json"
    if site_path.is_file():
        site = read_json(site_path)
        events = site.get("events", [])
        need(len(events) == 11, f"site events must be 11, got {len(events)}")
        need(all(row.get("type") in CLOUD_EVENT_TYPES for row in events),
             "site export contains non-G5 event types (offline_run/wake must be filtered)")
        need(all(row.get("source") == "cloud" for row in events), "site event source must be cloud")
        if offline_path.is_file():
            offline = read_json(offline_path)
            verified = next((row for row in events if row.get("type") == "recording_verified"), {})
            need(verified.get("bytes") == offline.get("inputBytes"), "recording_verified.bytes differs")
            need(verified.get("sha256") == offline.get("recordingSha256"),
                 "recording_verified.sha256 differs")

    # Verify the acoustic plan and chunk chain exactly as verify_acoustic does.
    checkpoint_path = evidence / "offline-checkpoint.bin"
    if checkpoint_path.is_file() and offline_path.is_file():
        try:
            checkpoint = read_checkpoint_summary(checkpoint_path)
            offline = read_json(offline_path)
            need(checkpoint["inputSha256"] == offline.get("recordingSha256"), "checkpoint input sha differs")
            plan = plan_windows(checkpoint["sampleCount"])
            need(len(resumed) == len(plan), f"resumed chunks {len(resumed)} != plan {len(plan)}")
            identity = recovery.get("identity") or {}
            previous = identity.get("decodeSha256")
            for index, window in enumerate(plan):
                path = evidence / f"acoustic-{index:02}.bin"
                if path.is_file():
                    try:
                        read_transfer_chunk(path, hashes.get(f"acoustic-{index:02}.bin", ""), identity,
                                            index, previous, window_bytes(window))
                    except Blocked as error:
                        failures.append(str(error))
                previous = hashes.get(f"acoustic-{index:02}.bin", previous)
        except (Blocked, OSError, json.JSONDecodeError, KeyError, struct.error) as error:
            failures.append(f"acoustic plan check failed: {error}")

    for name in ("gates.json", "offline.json", "runtime-profile.json", "official-run-history.json",
                 "site-event-export.json", "executor-event-export.json", "acoustic-recovery.json",
                 "platform-probe.json", "browser-acceptance.json", "browser-playback-events.json"):
        path = evidence / name
        if path.is_file():
            try:
                doc = read_json(path)
            except (OSError, json.JSONDecodeError) as error:
                failures.append(f"{name} is not valid JSON: {error}")
                continue
            for key in CANDIDATE:
                if key in manifest and key in doc and doc[key] != manifest[key]:
                    failures.append(f"{name}.{key} differs from manifest")
    if (evidence / "gates.json").is_file():
        gates = read_json(evidence / "gates.json")
        need(gates.get("releaseEligible") is True, "gates.releaseEligible must be true")
        need(all(gates.get("gates", {}).get(f"G{index}", {}).get("status") == "passed" for index in range(6)),
             "G0..G5 must all be passed")

    if require_signatures:
        for role in ROLES:
            sig = evidence / f"{role}.sig"
            if not sig.is_file():
                failures.append(f"missing signature {role}.sig")
            elif sig.stat().st_size == 0:
                failures.append(f"empty signature {role}.sig")

    if failures:
        for failure in failures:
            print(f"FAIL  {failure}")
        print(f"\n{len(failures)} problem(s); bundle is not verifiable.")
        return 1
    print(f"PASS  {len(FILES)} regular files + {len(chunks)} acoustic plan chunks + bindings")
    print("note: signatures and deeper verifier checks still run via verify_cloud_release.py")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", type=Path, metavar="EVIDENCE_DIR")
    parser.add_argument("--allow-missing-signatures", action="store_true")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--static-dir", type=Path, default=Path("static"))
    args = parser.parse_args()
    try:
        if args.check:
            return check(args.check.resolve(), not args.allow_missing_signatures)
        if args.build:
            require(args.run_dir is not None and args.out is not None, "--build needs --run-dir and --out")
            build(args.run_dir.resolve(), args.out.resolve(), args.static_dir.resolve())
            return 0
        parser.error("choose --check or --build")
    except Blocked as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError, KeyError, TypeError, struct.error) as error:
        print(f"BLOCKED: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())