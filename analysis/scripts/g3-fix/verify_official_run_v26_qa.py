#!/usr/bin/env python3
"""Bandroom G3 v26 QA variant of the independent A/B/C evidence verifier.

DERIVED, VERSIONED ARTIFACT. The frozen original
``verify_official_run_v26.py`` (sha256 eba9712d..., re-freeze register
STREAM2_REPORT.md) is preserved byte-for-byte and is NOT edited. This QA
variant re-freezes the two owner-approved V2/BL3/BL4 changes only:

1. officialRefs is now REQUIRED. It must be a dict carrying stage entries
   A/B/C, each with a lowercase-UUID ``officialRunId``. The frozen verifier
   silently skipped the check when ``officialRefs`` was absent or when a
   stage entry was missing (MJ2 blind spot). Per-stage ``userTurnId`` /
   ``assistantMessageId`` / ``turnKey`` become optional enrichment; when
   present they must be non-empty strings.
2. ``--observation-waiver`` (stage-c/bundle) is bound to
   ``history.observationWaiver`` plus ``history.formalG5ObservationWaived is
   false``. When it is effective, the ``>= 3 empty-queue wakes`` and
   ``>= 86400 s span`` checks are reported explicitly as WAIVED (never as
   PASS), not silently passed. Without the flag they fail exactly as in the
   frozen original. The waiver is QA-only and never applies to formal G5.

Everything else is unchanged from the frozen original. This verifier never
contacts a network or a cloud service.

Original frozen docstring follows
---------------------------------
Independent verifier for Bandroom G3 v26 official HJK A/B/C evidence.

This verifier pins the v26 int8 artifacts and the v26 checkpoint-chain
representation. It deliberately rejects the v24 CUPE references
(prefix 4779241b..., 21440 bytes, model 7ed14d8f...): those values belong to a
different bundle and must never be accepted for v26.

Pinned v26 contract
-------------------
* encoder-int8.onnx sha256 913f30b9... and probe-head.onnx sha256 813c83...
* prefix = 125,976 bytes split into exactly six parts, each <= 24,576 bytes
* checkpoint-0 metadata carries partCount/prefixBytes/prefixSha256/part SHAs
* final output schema is bandroom.qa.acoustic-output.v1 (mode diagnostic)
* HJK output manifest feedback starts with the fixed disclaimer and carries
  three human-annotation markers bound to truth.json sha 394fcb74...
* hard gate: official cloud cold output == official resumed output, byte equal

The verifier never contacts a network or a cloud service. It only reads the
evidence files supplied locally.

Usage
-----
  verify_official_run_v26.py stage-a --report A.json [--status status.json]
  verify_official_run_v26.py stage-b --metadata checkpoint-0.json --parts-dir DIR --report B.json \
      [--offline offline.json --site-events site-event-export.json --history official-run-history.json]
  verify_official_run_v26.py stage-c --metadata checkpoint-0.json --parts-dir DIR \
      --output checkpoint-7.json --cold cold.bin --resumed resumed.bin --report C.json \
      [--history official-run-history.json] [--offline offline.json --site-events site-event-export.json]
  verify_official_run_v26.py bundle --dir EVIDENCE_DIR [--history FILE]

G5 coverage: offline.runs must carry automationId and offline.isolated must be
true; the B-run recording_verified site event must carry bytes and sha256 bound
to offline.inputBytes/recordingSha256. bundle mode requires offline.json and
site-event-export.json.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Iterable

ENCODER_SHA256 = "913f30b95735bbf2e7d80dc93066e2730dc02bd0d19fb4a6b7cfefab657ed07c"
PROBE_HEAD_SHA256 = "813c832bebffb68087be08544a1be100c1e73dda6f431d7a4731084e22430370"
RECORDING_SHA256 = "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1"
TRUTH_SHA256 = "394fcb74a4221278aa7df02ead49a3743da6293c527617c7f973b1a52c062e28"
FEEDBACK_PREFIX = "声学链路验收（不代表纠音盲测达标）。"
OUTPUT_SCHEMA = "bandroom.qa.acoustic-output.v1"
PREFIX_BYTES = 125_976
PREFIX_PARTS = 6
MAX_PART_BYTES = 24_576
HJK_WINDOWS = 859
HJK_DURATION = 68.699728
DURATION_TOLERANCE = 0.01
ANCHORS = (
    ("business", 3.360, 3.660),
    ("and", 11.440, 11.740),
    ("suitcase", 55.209724, 55.509724),
)
# G5 verify_work expects exactly these cloud event types for each A/B/C run.
WORK_EVENTS = {
    "A": ("claimed", "retry_wait"),
    "B": ("claimed", "recording_verified", "checkpoint_saved", "interrupted"),
    "C": ("claimed", "checkpoint_restored", "suffix_completed", "feedback_committed", "receipt_readback"),
}
# v24 CUPE values. Never accepted as v26 evidence.
V24_PREFIX_SHA256 = "4779241b7b1a8276f82385d633f4b147dbcfd9deb90cb5657d75ef9329507125"
V24_PREFIX_BYTES = 21_440
V24_MODEL_SHA256 = "7ed14d8ffe603bda67e687ec084d2c5eeab3e04bfab2389af69479f31ec764dd"

# Canonical recipe description from V26_SOLUTION_DESIGN.md section 2 (B4).
RECIPE_DESCRIPTION = {
    "model": {"encoder": ENCODER_SHA256, "probe": PROBE_HEAD_SHA256},
    "runtime": {"ort": "1.24.4", "target": "cp312-manylinux-x86_64"},
    "sampleRateHz": 16000,
    "windowMs": 120,
    "strideMs": 80,
    "frameMs": 20,
    "prefixWindows": 8,
    "batch": 8,
    "intraOpThreads": 2,
    "interOpThreads": 1,
    "keepsAllWindowFrames": True,
    "mode": "diagnostic",
}
RECIPE_SHA256 = sha256(
    json.dumps(RECIPE_DESCRIPTION, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
).hexdigest()

DIGEST = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


def file_sha(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


class Checks:
    def __init__(self, title: str) -> None:
        self.title = title
        # status is one of PASS / FAIL / WAIVED. WAIVED is never counted as a
        # pass: it is an explicit, labelled owner waiver (BL3).
        self.rows: list[tuple[str, str, str]] = []

    def add(self, ok: bool, name: str, detail: Any = "") -> None:
        text = "" if detail is None or detail == "" else str(detail)
        self.rows.append(("PASS" if ok else "FAIL", name, text))

    def waive(self, name: str, detail: Any = "") -> None:
        text = "" if detail is None or detail == "" else str(detail)
        self.rows.append(("WAIVED", name, text))

    def report(self) -> int:
        print(f"== {self.title} ==")
        failed = 0
        waived = 0
        for status, name, detail in self.rows:
            print(f"{status}  {name}" + (f"  [{detail}]" if detail else ""))
            failed += 1 if status == "FAIL" else 0
            waived += 1 if status == "WAIVED" else 0
        passed = len(self.rows) - failed - waived
        suffix = f", {waived} waived (explicit, not counted as passed)" if waived else ""
        print(f"\n{passed}/{len(self.rows)} checks passed{suffix}")
        return 1 if failed else 0


def get_any(obj: Any, *keys: str, default: Any = None) -> Any:
    if not isinstance(obj, dict):
        return default
    for key in keys:
        if key in obj and obj[key] is not None:
            return obj[key]
    return default


def dig(obj: Any, *path: str, default: Any = None) -> Any:
    current = obj
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def prefix_info(meta: dict) -> dict:
    nested = meta.get("prefix") if isinstance(meta.get("prefix"), dict) else {}
    return {
        "partCount": get_any(meta, "partCount", default=nested.get("partCount")),
        "bytes": get_any(meta, "prefixBytes", default=nested.get("bytes", nested.get("prefixBytes"))),
        "sha256": get_any(meta, "prefixSha256", default=nested.get("sha256", nested.get("prefixSha256"))),
        "parts": nested.get("parts", meta.get("parts")),
    }


def normalized_parts(value: Any) -> list[dict] | None:
    if not isinstance(value, list):
        return None
    parts: list[dict] = []
    for fallback, item in enumerate(value, start=1):
        if isinstance(item, str):
            parts.append({"index": fallback, "sha256": item, "byteLength": None})
        elif isinstance(item, dict):
            parts.append({
                "index": item.get("index", fallback),
                "sha256": get_any(item, "sha256", "sha", "prefixPartSha256"),
                "byteLength": get_any(item, "byteLength", "bytes", "length"),
            })
        else:
            parts.append({"index": fallback, "sha256": None, "byteLength": None})
    return parts


def check_forbidden_values(c: Checks, label: str, obj: Any) -> None:
    forbidden = {
        "prefixSha256": V24_PREFIX_SHA256,
        "modelSha256": V24_MODEL_SHA256,
        "encoderSha256": V24_MODEL_SHA256,
        "prefixBytes": V24_PREFIX_BYTES,
    }
    bad: list[str] = []
    for key, value in forbidden.items():
        if key in obj and obj.get(key) == value:
            bad.append(f"{key}={value}")
    c.add(not bad, f"{label}: no v24 CUPE reference", ", ".join(bad))


def check_pty_lines(c: Checks, label: str, obj: Any) -> None:
    keys = {"ptyLines", "commandLines", "base64Lines", "stdoutLines"}
    lines: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in keys and isinstance(child, list):
                    lines.extend(item for item in child if isinstance(item, str))
                else:
                    walk(child)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(obj)
    if lines:
        longest = max(len(line) for line in lines)
        c.add(longest <= 3000, f"{label}: PTY/base64 lines <= 3000 characters", f"longest={longest}")


def check_chain(meta: dict, part_paths: list[Path], c: Checks, label: str) -> dict:
    info = prefix_info(meta)
    c.add(isinstance(meta.get("schema"), str) and bool(meta.get("schema")), f"{label}: metadata schema present",
          meta.get("schema"))
    c.add(get_any(meta, "recordingSha256") == RECORDING_SHA256, f"{label}: recording sha pinned",
          get_any(meta, "recordingSha256"))
    c.add(get_any(meta, "recipeSha256") == RECIPE_SHA256, f"{label}: v26 recipe sha pinned",
          get_any(meta, "recipeSha256"))
    c.add(get_any(meta, "modelSha256") == ENCODER_SHA256, f"{label}: v26 encoder-int8 sha pinned",
          get_any(meta, "modelSha256"))
    c.add(isinstance(get_any(meta, "runnerSha256"), str) and bool(DIGEST.match(get_any(meta, "runnerSha256") or "")),
          f"{label}: runner sha recorded", get_any(meta, "runnerSha256"))
    pcm = get_any(meta, "pcmSha256")
    c.add(isinstance(pcm, str) and bool(DIGEST.match(pcm)), f"{label}: official PCM sha recorded", pcm)
    samples = get_any(meta, "samples")
    c.add(is_int(samples) and samples > 0, f"{label}: sample count recorded", samples)
    windows = get_any(meta, "windows")
    c.add(is_int(windows) and windows >= 1, f"{label}: window count is a safe positive integer", windows)
    duration = get_any(meta, "duration")
    c.add(is_finite_number(duration) and 0 < duration <= 181, f"{label}: duration in (0,181]", duration)
    runtime = get_any(meta, "runtime")
    c.add(isinstance(runtime, dict) and bool(runtime), f"{label}: runtime recorded", runtime)
    c.add(not isinstance(runtime, dict) or runtime.get("ort") in (None, "1.24.4"),
          f"{label}: runtime ORT 1.24.4", runtime.get("ort") if isinstance(runtime, dict) else None)
    c.add(info["partCount"] == PREFIX_PARTS, f"{label}: partCount = {PREFIX_PARTS}", info["partCount"])
    c.add(info["bytes"] == PREFIX_BYTES, f"{label}: prefix bytes = {PREFIX_BYTES}", info["bytes"])
    c.add(isinstance(info["sha256"], str) and bool(DIGEST.match(info["sha256"] or "")),
          f"{label}: prefix sha is 64-hex", info["sha256"])
    c.add(info["sha256"] != V24_PREFIX_SHA256, f"{label}: prefix sha is not the v24 CUPE value", info["sha256"])
    check_forbidden_values(c, label, meta)

    declared = normalized_parts(info["parts"])
    if declared is not None:
        c.add(len(declared) == PREFIX_PARTS, f"{label}: per-part manifest has {PREFIX_PARTS} entries", len(declared))
        for position, part in enumerate(declared, start=1):
            c.add(part.get("index") == position, f"{label}: part {position} index", part.get("index"))
            c.add(isinstance(part.get("sha256"), str) and bool(DIGEST.match(part.get("sha256") or "")),
                  f"{label}: part {position} sha is 64-hex", part.get("sha256"))
            length = part.get("byteLength")
            c.add(length is None or (is_int(length) and 0 < length <= MAX_PART_BYTES),
                  f"{label}: part {position} <= {MAX_PART_BYTES} bytes", length)
    else:
        c.add(False, f"{label}: per-part SHA manifest present (partCount/parts)")

    c.add(len(part_paths) == PREFIX_PARTS, f"{label}: {PREFIX_PARTS} checkpoint part files", len(part_paths))
    total = 0
    actual_digests: list[str] = []
    for position, path in enumerate(part_paths, start=1):
        if not path.is_file():
            c.add(False, f"{label}: part {position} file exists", path)
            continue
        data = path.read_bytes()
        total += len(data)
        actual_digests.append(sha256(data).hexdigest())
        c.add(0 < len(data) <= MAX_PART_BYTES,
              f"{label}: part {position} size <= {MAX_PART_BYTES}", f"{len(data)} B")
        if declared is not None and position <= len(declared) and declared[position - 1].get("sha256"):
            c.add(actual_digests[-1] == declared[position - 1]["sha256"],
                  f"{label}: part {position} sha matches manifest", actual_digests[-1])
    c.add(total == PREFIX_BYTES, f"{label}: reassembled prefix = {PREFIX_BYTES} bytes", total)
    combined = sha256()
    for path in part_paths:
        if path.is_file():
            combined.update(path.read_bytes())
    if total == PREFIX_BYTES:
        c.add(combined.hexdigest() == info["sha256"], f"{label}: reassembled prefix sha matches metadata",
              combined.hexdigest())
    return {"prefixSha256": info["sha256"], "partCount": info["partCount"], "partShas": actual_digests}


def part_paths_for(args: argparse.Namespace, part_count: int = PREFIX_PARTS) -> list[Path]:
    if getattr(args, "part", None):
        return [Path(item) for item in args.part]
    directory = Path(getattr(args, "parts_dir", None) or Path(args.metadata).parent)
    return [directory / f"checkpoint-{index}.bin" for index in range(1, part_count + 1)]


def nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def event_run_id(event: dict) -> Any:
    return get_any(event, "officialRunId", "official_run_id", "runId")


def check_g5_work_fields(offline: dict, history: dict | None, site: dict, c: Checks,
                         label: str = "G5 work") -> None:
    """Cover the two G5 verify_work requirements that are easy to miss.

    * every offline run record carries automationId and offline.isolated is true
    * the B-run recording_verified event carries bytes and sha256 bound to the
      original recording
    The full A/B/C event sequences and cloud source are also checked when the
    export is available. Wake and offline_run audit rows are ignored here; the
    G5 site export must contain only the nine cloud event types.
    """
    c.add(isinstance(offline, dict), f"{label}: offline.json object", type(offline).__name__)
    if not isinstance(offline, dict):
        return
    c.add(offline.get("isolated") is True, f"{label}: offline.isolated = true", offline.get("isolated"))
    recording_sha = get_any(offline, "recordingSha256", "recording_sha256")
    c.add(isinstance(recording_sha, str) and bool(DIGEST.match(recording_sha or "")),
          f"{label}: offline recordingSha256 is 64-hex", recording_sha)
    input_bytes = get_any(offline, "inputBytes", "input_bytes")
    c.add(is_int(input_bytes) and input_bytes > 0, f"{label}: offline inputBytes positive", input_bytes)
    runs = get_any(offline, "runs")
    c.add(isinstance(runs, list) and len(runs) == 3, f"{label}: offline runs length 3",
          len(runs) if isinstance(runs, list) else type(runs).__name__)
    if not isinstance(runs, list):
        runs = []

    automation = get_any(history or {}, "automationId", "automation_id") if isinstance(history, dict) else None
    if automation is not None:
        c.add(nonempty_text(automation), f"{label}: history automationId recorded", automation)

    seen_ids: set[Any] = set()
    by_step: dict[str, dict] = {}
    for index, run in enumerate(runs):
        ok = isinstance(run, dict)
        c.add(ok, f"{label}: offline run {index} object")
        if not ok:
            continue
        step = str(get_any(run, "step", "stage") or "ABC"[index]).upper()
        c.add(step in WORK_EVENTS, f"{label}: offline run {index} step A/B/C", step)
        run_id = event_run_id(run)
        c.add(nonempty_text(run_id), f"{label}: offline run {step} officialRunId recorded", run_id)
        c.add(run_id not in seen_ids, f"{label}: offline run {step} officialRunId distinct", run_id)
        if run_id is not None:
            seen_ids.add(run_id)
        run_automation = get_any(run, "automationId", "automation_id")
        c.add(nonempty_text(run_automation), f"{label}: offline run {step} automationId recorded", run_automation)
        if automation is not None and run_automation is not None:
            c.add(run_automation == automation, f"{label}: offline run {step} automationId matches history",
                  run_automation)
        if "isolated" in run:
            c.add(run.get("isolated") is True, f"{label}: offline run {step} isolated true", run.get("isolated"))
        fence = get_any(run, "fence")
        c.add(is_int(fence) and fence >= 1, f"{label}: offline run {step} fence >= 1", fence)
        by_step[step] = run
    c.add(set(by_step) == {"A", "B", "C"}, f"{label}: offline A/B/C runs present", sorted(by_step))

    if isinstance(history, dict):
        records = get_any(history, "runs")
        c.add(isinstance(records, list) and len(records) >= 3, f"{label}: official history runs present",
              len(records) if isinstance(records, list) else type(records).__name__)
        if isinstance(records, list):
            for record in records:
                c.add(get_any(record, "automationId", "automation_id") == automation,
                      f"{label}: history run automationId matches", get_any(record, "automationId"))

    events = get_any(site, "events") if isinstance(site, dict) else None
    c.add(isinstance(events, list), f"{label}: site event export present", type(events).__name__)
    if not isinstance(events, list):
        return
    cloud_events = [event for event in events if isinstance(event, dict) and
                    get_any(event, "type") not in ("wake", "offline_run")]
    for step, expected in WORK_EVENTS.items():
        run = by_step.get(step)
        if not run:
            continue
        run_id = event_run_id(run)
        rows = [event for event in cloud_events if event_run_id(event) == run_id]
        c.add([get_any(event, "type") for event in rows] == list(expected),
              f"{label}: stage {step} cloud event sequence", [get_any(event, "type") for event in rows])
        for event in rows:
            c.add(get_any(event, "source") == "cloud", f"{label}: stage {step} event source cloud",
                  get_any(event, "source"))
            c.add(get_any(event, "fence") in (None, get_any(run, "fence")),
                  f"{label}: stage {step} event fence matches run", get_any(event, "fence"))
            event_automation = get_any(event, "automationId", "automation_id")
            if automation is not None and event_automation is not None:
                c.add(event_automation == automation, f"{label}: stage {step} event automationId matches",
                      event_automation)
            if "isolated" in event:
                c.add(event.get("isolated") is True, f"{label}: stage {step} event isolated true",
                      event.get("isolated"))

    b_run = by_step.get("B")
    if b_run:
        b_rows = [event for event in cloud_events if event_run_id(event) == event_run_id(b_run)]
        verified = [event for event in b_rows if get_any(event, "type") == "recording_verified"]
        c.add(len(verified) == 1, f"{label}: B run has one recording_verified event", len(verified))
        if verified:
            event = verified[0]
            event_bytes = get_any(event, "bytes")
            event_sha = get_any(event, "sha256")
            c.add(is_int(event_bytes) and event_bytes > 0, f"{label}: B recording_verified bytes positive",
                  event_bytes)
            c.add(isinstance(event_sha, str) and bool(DIGEST.match(event_sha or "")),
                  f"{label}: B recording_verified sha256 is 64-hex", event_sha)
            c.add(event_bytes == input_bytes, f"{label}: B recording_verified bytes == offline.inputBytes",
                  f"{event_bytes} vs {input_bytes}")
            c.add(event_sha == recording_sha, f"{label}: B recording_verified sha256 == offline.recordingSha256",
                  event_sha)


def observation_waiver_state(history: dict, c: Checks, label: str) -> tuple[bool, str]:
    """Resolve the QA-only empty-queue observation waiver.

    The flag alone is not enough. The waiver is effective only when the
    history carries an explicit observationWaiver record AND
    formalG5ObservationWaived is exactly false. Anything else leaves the
    frozen checks in force, so a QA waiver can never leak into formal G5.
    """
    waiver = get_any(history, "observationWaiver", "observation_waiver")
    explicit = False
    if isinstance(waiver, dict):
        explicit = (waiver.get("waived") is True
                    and bool(waiver.get("reason") or waiver.get("approvedBy") or waiver.get("scope")))
    elif isinstance(waiver, str):
        explicit = bool(waiver.strip())
    c.add(explicit, f"{label}: observationWaiver record present (explicit QA waiver)", waiver)
    formal_waived = get_any(history, "formalG5ObservationWaived", "formal_g5_observation_waived",
                            default="missing")
    c.add(formal_waived is False,
          f"{label}: formalG5ObservationWaived = false (waiver is QA-only, never formal G5)",
          formal_waived)
    if not explicit:
        return False, "no explicit observationWaiver record"
    if formal_waived is not False:
        return False, "formalG5ObservationWaived is not false"
    reason = waiver if isinstance(waiver, str) else (
        waiver.get("reason") or waiver.get("scope") or "owner observation waiver")
    return True, str(reason)


def check_official_refs(history: dict, c: Checks, label: str) -> None:
    """MJ2 blind-spot closure: officialRefs is mandatory, carries A/B/C, and
    every stage needs a lowercase-UUID officialRunId. Turn/message IDs are
    optional enrichment only.

    This runs before the empty-queue wake checks so a malformed or absent
    ``emptyQueueWakes`` cannot hide an absent ``officialRefs`` block.
    """
    refs = get_any(history, "officialRefs", "official_refs")
    c.add(isinstance(refs, dict), f"{label}: officialRefs object present", type(refs).__name__)
    if not isinstance(refs, dict):
        return
    for stage in ("A", "B", "C"):
        ref = refs.get(stage)
        if not isinstance(ref, dict):
            ref = refs.get(stage.lower())
        c.add(isinstance(ref, dict), f"{label}: stage {stage} officialRefs entry present",
              type(ref).__name__)
        if not isinstance(ref, dict):
            continue
        official_run_id = get_any(ref, "officialRunId", "official_run_id")
        c.add(isinstance(official_run_id, str) and bool(UUID.match(official_run_id or "")),
              f"{label}: stage {stage} officialRunId is lowercase UUID", official_run_id)
        for key in ("userTurnId", "assistantMessageId", "turnKey"):
            if key in ref and ref[key] is not None:
                c.add(isinstance(ref[key], str) and bool(ref[key].strip()),
                      f"{label}: stage {stage} {key} enrichment is non-empty", ref[key])


def check_history(history: dict, c: Checks, label: str = "history",
                  observation_waiver: bool = False) -> None:
    check_official_refs(history, c, label)
    wakes = get_any(history, "emptyQueueWakes", "empty_queue_wakes")
    c.add(isinstance(wakes, list), f"{label}: emptyQueueWakes list present", type(wakes).__name__)
    if not isinstance(wakes, list):
        return
    waived = False
    waiver_detail = ""
    if observation_waiver:
        waived, waiver_detail = observation_waiver_state(history, c, label)
    if waived:
        c.waive(f"{label}: >= 3 official empty-queue wakes",
                f"WAIVED by owner observation waiver: {waiver_detail}")
    else:
        c.add(len(wakes) >= 3, f"{label}: >= 3 official empty-queue wakes", len(wakes))
    stamps: list[datetime] = []
    for index, wake in enumerate(wakes):
        if not isinstance(wake, dict):
            c.add(False, f"{label}: wake {index} object")
            continue
        utc = get_any(wake, "utc", "at", "timestamp")
        parsed: datetime | None = None
        if isinstance(utc, str):
            try:
                parsed = datetime.fromisoformat(utc.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                stamps.append(parsed)
            except ValueError:
                parsed = None
        c.add(parsed is not None, f"{label}: wake {index} UTC parse", utc)
        c.add(get_any(wake, "pendingCount", "pending_count") == 0,
              f"{label}: wake {index} pendingCount = 0", get_any(wake, "pendingCount", "pending_count"))
        c.add(get_any(wake, "pendingAcoustics", "pending_acoustics", default=0) == 0,
              f"{label}: wake {index} pendingAcoustics = 0",
              get_any(wake, "pendingAcoustics", "pending_acoustics", default=0))
        c.add(get_any(wake, "subscriptionActive", "subscription_active") is True,
              f"{label}: wake {index} subscriptionActive = true",
              get_any(wake, "subscriptionActive", "subscription_active"))
    if waived:
        span = ""
        if len(stamps) >= 2:
            span = f"observed span {(max(stamps) - min(stamps)).total_seconds():.0f}s, "
        c.waive(f"{label}: wake span >= 86400s",
                f"{span}WAIVED by owner observation waiver: {waiver_detail}")
    elif len(stamps) >= 2:
        span = (max(stamps) - min(stamps)).total_seconds()
        c.add(span >= 86_400, f"{label}: wake span >= 86400s", f"{span:.0f}s")

    # officialRefs was already checked by check_official_refs().
    events = get_any(history, "siteEvents", "site_events")
    if isinstance(events, list) and events:
        ids = [get_any(event, "id") for event in events]
        c.add(all(is_int(value) for value in ids), f"{label}: site event ids are integers")
        c.add(all(ids[index] > ids[index - 1] for index in range(1, len(ids))),
              f"{label}: site event ids strictly increasing (append-only)")


def check_a(report: dict, status_doc: dict | None, c: Checks) -> None:
    stage = get_any(report, "stage", "phase", "stageName")
    c.add(str(stage).strip().lower() in {"a", "stage-a", "stage_a", "prefix-claim"}, "stage A report identity", stage)
    run_id = get_any(report, "runId", "serverRunId")
    c.add(isinstance(run_id, str) and bool(UUID.match(run_id or "")), "stage A runId is lowercase UUID", run_id)
    fence = get_any(report, "fence", "serverFence")
    c.add(is_int(fence) and fence >= 1, "stage A fence >= 1", fence)
    next_index = get_any(report, "nextIndex", "committedParts", "nextIndexAfter")
    c.add(next_index == 0, "stage A saved no prefix (nextIndex 0)", next_index)
    claim = get_any(report, "claimStatus", "claim")
    if isinstance(claim, dict):
        claim = get_any(claim, "status")
    c.add(claim in (None, "leased"), "stage A claim leased", claim)
    retry = get_any(report, "retryStatus", "retry", "reviewState", "retryState")
    if isinstance(retry, dict):
        retry = get_any(retry, "status", "state")
    c.add(str(retry).lower() in {"retry_scheduled", "retry_wait", "retry", "waiting"},
          "stage A recording-read transient moved to retry_wait", retry)
    reason = get_any(report, "retryReason", "reason")
    c.add(reason in (None, "recording_read_failed"), "stage A retry reason is client-declared recording_read_failed", reason)
    injected = get_any(report, "injectedFault", "recordingReadFailed", "injectedRecordingReadFailure")
    c.add(injected in (None, True), "stage A transient is recorded as injected", injected)
    saved = get_any(report, "savedParts", "partsSaved", "savedPartCount")
    c.add(saved in (None, 0), "stage A report asserts zero saved parts", saved)
    check_forbidden_values(c, "stage A report", report)
    check_pty_lines(c, "stage A report", report)
    if isinstance(status_doc, dict):
        acoustics = get_any(status_doc, "pendingAcoustics", "pending_acoustics", default=[])
        target = acoustics[0] if isinstance(acoustics, list) and acoustics else None
        c.add(isinstance(target, dict), "stage A status contains the HJK pending acoustic job", target)
        if isinstance(target, dict):
            c.add(get_any(target, "nextIndex", "next_index") == 0, "stage A status nextIndex 0",
                  get_any(target, "nextIndex", "next_index"))
            c.add(get_any(target, "retryReason", "retry_reason") == "recording_read_failed",
                  "stage A status retryReason recording_read_failed",
                  get_any(target, "retryReason", "retry_reason"))
        active = get_any(status_doc, "subscriptionActive", "subscription_active")
        if active is None and isinstance(status_doc.get("subscription"), dict):
            active = status_doc["subscription"].get("active")
        c.add(active is True, "stage A status subscriptionActive true", active)


def check_b(report: dict, chain: dict, c: Checks) -> None:
    stage = get_any(report, "stage", "phase", "stageName")
    c.add(str(stage).strip().lower() in {"b", "stage-b", "stage_b", "checkpoint-chain"}, "stage B report identity", stage)
    run_id = get_any(report, "runId", "serverRunId")
    c.add(isinstance(run_id, str) and bool(UUID.match(run_id or "")), "stage B runId is lowercase UUID", run_id)
    fence = get_any(report, "fence", "serverFence")
    c.add(is_int(fence) and fence >= 1, "stage B fence >= 1", fence)
    c.add(get_any(report, "nextIndex", "committedParts", "nextIndexAfter") == PREFIX_PARTS + 1,
          f"stage B nextIndex = {PREFIX_PARTS + 1}", get_any(report, "nextIndex", "committedParts", "nextIndexAfter"))
    c.add(get_any(report, "prefixSha256", "prefix_sha256") in (None, chain["prefixSha256"]),
          "stage B prefix sha matches chain", get_any(report, "prefixSha256", "prefix_sha256"))
    c.add(get_any(report, "partCount", "savedParts") in (None, PREFIX_PARTS, PREFIX_PARTS + 1),
          "stage B part count recorded", get_any(report, "partCount", "savedParts"))
    interrupted = get_any(report, "interrupted", "computeBudgetRetry", "stopped")
    c.add(interrupted in (None, True), "stage B stopped with the prefix retained", interrupted)
    remaining = get_any(report, "remainingWindows", "suffixWindows")
    c.add(remaining in (None, 851), "stage B remaining suffix windows = 851", remaining)
    c.add(get_any(report, "coldResumedEqual") is not True,
          "stage B does not claim a completed cold/resumed gate",
          get_any(report, "coldResumedEqual"))
    written = get_any(report, "writtenBy", "partsWrittenBy")
    if isinstance(written, dict):
        c.add(written.get("runId") == run_id, "stage B part writer is this run", written.get("runId"))
        c.add(written.get("fence") == fence, "stage B part writer fence is this fence", written.get("fence"))
    check_forbidden_values(c, "stage B report", report)
    check_pty_lines(c, "stage B report", report)


def check_output(output: dict, output_file_sha: str, chain: dict, cold: Path, resumed: Path,
                 report: dict | None, c: Checks) -> None:
    c.add(output.get("schema") == OUTPUT_SCHEMA, "output schema " + OUTPUT_SCHEMA, output.get("schema"))
    c.add(output.get("mode") == "diagnostic", "output mode diagnostic (not G2)", output.get("mode"))
    c.add(output.get("recordingSha256") == RECORDING_SHA256, "output recording sha pinned", output.get("recordingSha256"))
    c.add(output.get("recipeSha256") == RECIPE_SHA256, "output v26 recipe sha pinned", output.get("recipeSha256"))
    run_id = output.get("runId")
    c.add(isinstance(run_id, str) and bool(UUID.match(run_id or "")), "output runId is lowercase UUID", run_id)
    fence = output.get("fence")
    c.add(is_int(fence) and fence >= 1, "output fence >= 1", fence)
    cold_sha = output.get("coldOutputSha256")
    resumed_sha = output.get("resumedOutputSha256")
    c.add(isinstance(cold_sha, str) and bool(DIGEST.match(cold_sha or "")), "coldOutputSha256 is 64-hex", cold_sha)
    c.add(isinstance(resumed_sha, str) and bool(DIGEST.match(resumed_sha or "")), "resumedOutputSha256 is 64-hex", resumed_sha)
    c.add(cold_sha == resumed_sha, "HARD GATE output manifest cold == resumed", cold_sha)
    windows = output.get("windows")
    c.add(is_int(windows) and windows >= 1, "output windows is a safe positive integer", windows)
    duration = output.get("duration")
    c.add(is_finite_number(duration) and 0 < duration <= 181, "output duration in (0,181]", duration)
    raw = output.get("rawOutputBytes")
    c.add(is_int(raw) and raw > 0, "rawOutputBytes positive integer", raw)
    pcm = output.get("pcmSha256")
    c.add(isinstance(pcm, str) and bool(DIGEST.match(pcm or "")), "output PCM sha recorded", pcm)
    c.add(output.get("modelSha256") == ENCODER_SHA256, "output v26 encoder-int8 sha pinned", output.get("modelSha256"))
    runtime = output.get("runtime")
    c.add(isinstance(runtime, dict) and bool(runtime), "output runtime recorded", runtime)
    c.add(not isinstance(runtime, dict) or runtime.get("ort") in (None, "1.24.4"), "output ORT 1.24.4",
          runtime.get("ort") if isinstance(runtime, dict) else None)
    c.add(output.get("prefixSha256") == chain["prefixSha256"], "output prefix sha matches checkpoint chain",
          output.get("prefixSha256"))
    c.add(output.get("prefixBytes") in (None, PREFIX_BYTES), "output prefix bytes = " + str(PREFIX_BYTES),
          output.get("prefixBytes"))
    c.add(output.get("partCount") in (None, PREFIX_PARTS), "output partCount = " + str(PREFIX_PARTS),
          output.get("partCount"))
    check_forbidden_values(c, "output", output)

    text = output.get("feedback")
    c.add(isinstance(text, str) and 10 <= len(text) <= 800, "feedback length 10..800",
          len(text) if isinstance(text, str) else None)
    c.add(isinstance(text, str) and text.startswith(FEEDBACK_PREFIX),
          "feedback starts with the fixed diagnostic disclaimer", text[:40] if isinstance(text, str) else None)
    if report is not None:
        reported = get_any(report, "feedback")
        c.add(reported is None or reported == text, "report feedback equals output.feedback", reported)
        reported_quote = get_any(report, "quote")
        c.add(reported_quote is None or reported_quote == "[原声录音]", "quote is [原声录音]", reported_quote)

    markers = output.get("markers")
    c.add(isinstance(markers, list) and len(markers) <= 6, "markers list <= 6",
          len(markers) if isinstance(markers, list) else type(markers).__name__)
    if isinstance(markers, list):
        for index, marker in enumerate(markers):
            ok = isinstance(marker, dict)
            c.add(ok, f"marker {index} object")
            if not ok:
                continue
            c.add(marker.get("source") == "human_annotation", f"marker {index} source human_annotation",
                  marker.get("source"))
            c.add(marker.get("truthSha256") == TRUTH_SHA256, f"marker {index} truth sha pinned",
                  marker.get("truthSha256"))
            word = marker.get("word")
            c.add(isinstance(word, str) and 0 < len(word) <= 80, f"marker {index} word <= 80",
                  word if not isinstance(word, str) else f"{word!r} ({len(word)})")
            start = marker.get("start")
            end = marker.get("end")
            c.add(is_finite_number(start) and is_finite_number(end) and start >= 0 and start < end,
                  f"marker {index} 0 <= start < end", f"{start}..{end}")
            c.add(is_finite_number(end) and is_finite_number(duration) and end <= duration,
                  f"marker {index} end <= duration", end)
        matched = True
        for word, start, end in ANCHORS:
            found = any(isinstance(marker, dict) and marker.get("word") == word and
                        is_finite_number(marker.get("start")) and abs(marker["start"] - start) <= 1e-6 and
                        is_finite_number(marker.get("end")) and abs(marker["end"] - end) <= 1e-6
                        for marker in markers)
            c.add(found, f"human anchor {word} {start}-{end}", found)
            matched = matched and found
        c.add(matched, "all three HJK truth anchors present exactly")

    cold_bytes = cold.read_bytes() if cold.is_file() else b""
    resumed_bytes = resumed.read_bytes() if resumed.is_file() else b""
    c.add(cold.is_file() and resumed.is_file(), "cold and resumed output files exist",
          f"cold={cold.is_file()} resumed={resumed.is_file()}")
    c.add(cold_bytes == resumed_bytes, "HARD GATE official cloud cold == resumed byte equality",
          f"{len(cold_bytes)} B")
    c.add(sha256(cold_bytes).hexdigest() == cold_sha, "cold bytes match coldOutputSha256", sha256(cold_bytes).hexdigest())
    c.add(sha256(resumed_bytes).hexdigest() == resumed_sha, "resumed bytes match resumedOutputSha256",
          sha256(resumed_bytes).hexdigest())
    c.add(is_int(raw) and raw == len(cold_bytes), "rawOutputBytes matches cold length", f"raw={raw} cold={len(cold_bytes)}")

    if report is not None:
        c.add(get_any(report, "coldResumedEqual") is True, "report coldResumedEqual true",
              get_any(report, "coldResumedEqual"))
        c.add(get_any(report, "runId", "serverRunId") in (None, run_id), "report runId matches output",
              get_any(report, "runId", "serverRunId"))
        c.add(get_any(report, "fence", "serverFence") in (None, fence), "report fence matches output",
              get_any(report, "fence", "serverFence"))
        c.add(get_any(report, "outputIndex", "output_index") in (None, PREFIX_PARTS + 1),
              "outputIndex = " + str(PREFIX_PARTS + 1), get_any(report, "outputIndex", "output_index"))
        c.add(get_any(report, "resumedOnlyWindows", "suffixWindows") in (None, 851),
              "resumed only computed 851 suffix windows", get_any(report, "resumedOnlyWindows", "suffixWindows"))
        receipt = get_any(report, "receipt", "completionReceipt")
        if isinstance(receipt, dict):
            c.add(receipt.get("outputSha256") == output_file_sha, "receipt binds output checkpoint file sha",
                  receipt.get("outputSha256"))
            c.add(receipt.get("outputIndex") == PREFIX_PARTS + 1, "receipt binds outputIndex 7", receipt.get("outputIndex"))
            c.add(receipt.get("runId") == run_id, "receipt binds runId", receipt.get("runId"))
            c.add(receipt.get("fence") == fence, "receipt binds fence", receipt.get("fence"))
        replay = get_any(report, "duplicateReplay", "lostReceiptReplay")
        if isinstance(replay, dict):
            c.add(replay.get("duplicate") is True, "lost-receipt replay returns duplicate=true", replay.get("duplicate"))
            c.add(replay.get("savedAt") in (None, receipt.get("savedAt") if isinstance(receipt, dict) else None),
                  "lost-receipt replay keeps savedAt", replay.get("savedAt"))
        stale = get_any(report, "staleFenceRejected", "oldFenceRejected")
        c.add(stale in (None, True), "stale fence/replay rejection recorded", stale)
        check_pty_lines(c, "stage C report", report)


def check_c(report: dict, chain: dict, output: dict, output_file_sha: str, cold: Path, resumed: Path,
            c: Checks) -> None:
    stage = get_any(report, "stage", "phase", "stageName")
    c.add(str(stage).strip().lower() in {"c", "stage-c", "stage_c", "resume-complete"}, "stage C report identity", stage)
    run_id = get_any(report, "runId", "serverRunId")
    c.add(isinstance(run_id, str) and bool(UUID.match(run_id or "")), "stage C runId is lowercase UUID", run_id)
    fence = get_any(report, "fence", "serverFence")
    c.add(is_int(fence) and fence >= 1, "stage C fence >= 1", fence)
    previous = get_any(report, "previousFence", "fenceBefore")
    c.add(previous is None or (is_int(fence) and fence == previous + 1),
          "stage C fence grew over the retained prefix", f"{previous} -> {fence}")
    c.add(get_any(report, "nextIndexBefore", "resumedFromIndex") in (None, PREFIX_PARTS + 1),
          "stage C resumed from nextIndex 7", get_any(report, "nextIndexBefore", "resumedFromIndex"))
    c.add(get_any(report, "nextIndex", "committedParts") in (None, PREFIX_PARTS + 2),
          "stage C final nextIndex 8", get_any(report, "nextIndex", "committedParts"))
    c.add(get_any(report, "prefixSha256", "prefix_sha256") in (None, chain["prefixSha256"]),
          "stage C prefix sha matches chain", get_any(report, "prefixSha256", "prefix_sha256"))
    check_forbidden_values(c, "stage C report", report)
    check_output(output, output_file_sha, chain, cold, resumed, report, c)


def stage_a(args: argparse.Namespace) -> int:
    c = Checks("v26 stage A (claim + injected recording-read transient + retry_wait)")
    report = load_json(Path(args.report))
    status_doc = load_json(Path(args.status)) if args.status else None
    check_a(report, status_doc, c)
    print(f"recipeSha256 {RECIPE_SHA256}")
    return c.report()


def stage_b(args: argparse.Namespace) -> int:
    c = Checks("v26 stage B (takeover + 125,976-byte six-part prefix + interruption)")
    meta = load_json(Path(args.metadata))
    parts = part_paths_for(args)
    chain = check_chain(meta, parts, c, "stage B")
    check_b(load_json(Path(args.report)), chain, c)
    if args.offline is not None or args.site_events is not None:
        c.add(bool(args.offline and args.site_events),
              "stage B G5 checks require both --offline and --site-events")
        if args.offline and args.site_events:
            check_g5_work_fields(load_json(Path(args.offline)),
                                 load_json(Path(args.history)) if args.history else None,
                                 load_json(Path(args.site_events)), c, "stage B G5")
    print(f"recipeSha256 {RECIPE_SHA256}")
    return c.report()


def stage_c(args: argparse.Namespace) -> int:
    c = Checks("v26 stage C (resume + cold==resumed hard gate + bound writeback)")
    meta = load_json(Path(args.metadata))
    parts = part_paths_for(args)
    chain = check_chain(meta, parts, c, "stage C")
    report = load_json(Path(args.report))
    output_path = Path(args.output)
    output_file_sha = file_sha(output_path)
    check_c(report, chain, load_json(output_path), output_file_sha, Path(args.cold), Path(args.resumed), c)
    c.add(output_file_sha == get_any(report, "outputSha256", "output_sha256"),
          "report.outputSha256 == sha(final output file)", output_file_sha)
    if args.offline is not None or args.site_events is not None:
        c.add(bool(args.offline and args.site_events),
              "stage C G5 checks require both --offline and --site-events")
        if args.offline and args.site_events:
            check_g5_work_fields(load_json(Path(args.offline)),
                                 load_json(Path(args.history)) if args.history else None,
                                 load_json(Path(args.site_events)), c, "stage C G5")
    if args.history:
        check_history(load_json(Path(args.history)), c,
                      observation_waiver=getattr(args, "observation_waiver", False))
    print(f"recipeSha256 {RECIPE_SHA256}")
    return c.report()


def bundle(args: argparse.Namespace) -> int:
    directory = Path(args.dir)
    c = Checks("v26 official run bundle")
    required = ["stage-a.json", "stage-b.json", "stage-c.json", "checkpoint-0.json",
                "checkpoint-7.json", "cold.bin", "resumed.bin", "offline.json",
                "site-event-export.json"]
    for name in required:
        c.add((directory / name).is_file(), f"required evidence file {name}")
    if not all((directory / name).is_file() for name in required):
        return c.report()
    status_doc = load_json(directory / "status.json") if (directory / "status.json").is_file() else None
    check_a(load_json(directory / "stage-a.json"), status_doc, c)
    meta = load_json(directory / "checkpoint-0.json")
    parts = [directory / f"checkpoint-{index}.bin" for index in range(1, PREFIX_PARTS + 1)]
    chain = check_chain(meta, parts, c, "bundle")
    check_b(load_json(directory / "stage-b.json"), chain, c)
    report = load_json(directory / "stage-c.json")
    output_path = directory / "checkpoint-7.json"
    output_file_sha = file_sha(output_path)
    check_c(report, chain, load_json(output_path), output_file_sha, directory / "cold.bin", directory / "resumed.bin", c)
    c.add(output_file_sha == get_any(report, "outputSha256", "output_sha256"),
          "report.outputSha256 == sha(checkpoint-7.json)", output_file_sha)
    history_path = Path(args.history) if args.history else directory / "official-run-history.json"
    history = load_json(history_path) if history_path.is_file() else None
    if history is not None:
        check_history(history, c,
                      observation_waiver=getattr(args, "observation_waiver", False))
    else:
        c.add(False, "official-run-history.json present")
    offline_path = Path(args.offline) if args.offline else directory / "offline.json"
    site_path = Path(args.site_events) if args.site_events else directory / "site-event-export.json"
    check_g5_work_fields(load_json(offline_path), history, load_json(site_path), c, "bundle G5")
    print(f"recipeSha256 {RECIPE_SHA256}")
    return c.report()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="stage", required=True)

    a = sub.add_parser("stage-a")
    a.add_argument("--report", required=True)
    a.add_argument("--status")
    a.set_defaults(fn=stage_a)

    b = sub.add_parser("stage-b")
    b.add_argument("--metadata", required=True)
    b.add_argument("--parts-dir")
    b.add_argument("--part", action="append")
    b.add_argument("--report", required=True)
    b.add_argument("--offline")
    b.add_argument("--site-events")
    b.add_argument("--history")
    b.set_defaults(fn=stage_b)

    cc = sub.add_parser("stage-c")
    cc.add_argument("--metadata", required=True)
    cc.add_argument("--parts-dir")
    cc.add_argument("--part", action="append")
    cc.add_argument("--output", required=True)
    cc.add_argument("--cold", required=True)
    cc.add_argument("--resumed", required=True)
    cc.add_argument("--report", required=True)
    cc.add_argument("--history")
    cc.add_argument("--offline")
    cc.add_argument("--site-events")
    cc.add_argument("--observation-waiver", action="store_true",
                    help="QA-only: bind history.observationWaiver + formalG5ObservationWaived=false; "
                         "report the >=3-wake/>=86400s checks as explicit WAIVED (never PASS)")
    cc.set_defaults(fn=stage_c)

    bd = sub.add_parser("bundle")
    bd.add_argument("--dir", required=True)
    bd.add_argument("--history")
    bd.add_argument("--offline")
    bd.add_argument("--site-events")
    bd.add_argument("--observation-waiver", action="store_true",
                    help="QA-only: bind history.observationWaiver + formalG5ObservationWaived=false; "
                         "report the >=3-wake/>=86400s checks as explicit WAIVED (never PASS)")
    bd.set_defaults(fn=bundle)

    args = parser.parse_args(list(argv) if argv is not None else None)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
