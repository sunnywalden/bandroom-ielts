#!/usr/bin/env python3
"""Self-test for verify_official_run_v26.py using synthetic local evidence.

These fixtures are not official Work artifacts. They only exercise the
verifier's contract checks and negative matrix.
"""

from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import io
import json
from pathlib import Path
import tempfile
import unittest
import uuid

import verify_official_run_v26 as v

PREFIX = bytes((index * 37 + 11) % 256 for index in range(v.PREFIX_BYTES))
PART_SIZE = v.PREFIX_BYTES // v.PREFIX_PARTS
PARTS = [PREFIX[index * PART_SIZE:(index + 1) * PART_SIZE] for index in range(v.PREFIX_PARTS)]
PREFIX_SHA = sha256(PREFIX).hexdigest()
COLD = bytes((index * 13 + 5) % 256 for index in range(1718))
COLD_SHA = sha256(COLD).hexdigest()


def run(*args: str) -> int:
    with contextlib.redirect_stdout(io.StringIO()):
        return v.main(args)


class Evidence:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.a_run = str(uuid.uuid4())
        self.b_run = str(uuid.uuid4())
        self.c_run = str(uuid.uuid4())
        (root / "checkpoint-1.bin").write_bytes(b"")
        meta = {
            "schema": "bandroom.qa.acoustic-checkpoint-chain.v1",
            "recordingSha256": v.RECORDING_SHA256,
            "recipeSha256": v.RECIPE_SHA256,
            "modelSha256": v.ENCODER_SHA256,
            "runnerSha256": sha256(b"runner").hexdigest(),
            "pcmSha256": sha256(b"pcm").hexdigest(),
            "samples": 1_099_196,
            "windows": v.HJK_WINDOWS,
            "duration": v.HJK_DURATION,
            "runtime": {"ort": "1.24.4", "target": "cp312-manylinux-x86_64"},
            "partCount": v.PREFIX_PARTS,
            "prefixBytes": v.PREFIX_BYTES,
            "prefixSha256": PREFIX_SHA,
            "parts": [
                {"index": index + 1, "sha256": sha256(part).hexdigest(), "byteLength": len(part)}
                for index, part in enumerate(PARTS)
            ],
        }
        self.metadata = meta
        self.write("checkpoint-0.json", meta)
        for index, part in enumerate(PARTS, start=1):
            (root / f"checkpoint-{index}.bin").write_bytes(part)
        self.write("cold.bin", COLD)
        self.write("resumed.bin", COLD)
        self.a_report = {
            "stage": "A", "runId": self.a_run, "fence": 1, "nextIndex": 0,
            "claimStatus": "leased", "retryStatus": "retry_scheduled",
            "retryReason": "recording_read_failed", "injectedFault": True, "savedParts": 0,
        }
        self.b_report = {
            "stage": "B", "runId": self.b_run, "fence": 2, "nextIndex": v.PREFIX_PARTS + 1,
            "prefixSha256": PREFIX_SHA, "partCount": v.PREFIX_PARTS, "interrupted": True,
            "remainingWindows": 851, "coldResumedEqual": False,
            "writtenBy": {"runId": self.b_run, "fence": 2},
        }
        self.output = {
            "schema": v.OUTPUT_SCHEMA, "mode": "diagnostic",
            "recordingSha256": v.RECORDING_SHA256, "recipeSha256": v.RECIPE_SHA256,
            "runId": self.c_run, "fence": 3,
            "coldOutputSha256": COLD_SHA, "resumedOutputSha256": COLD_SHA,
            "windows": v.HJK_WINDOWS, "duration": v.HJK_DURATION, "rawOutputBytes": len(COLD),
            "pcmSha256": sha256(b"pcm").hexdigest(), "modelSha256": v.ENCODER_SHA256,
            "runtime": {"ort": "1.24.4", "target": "cp312-manylinux-x86_64"},
            "prefixSha256": PREFIX_SHA, "prefixBytes": v.PREFIX_BYTES, "partCount": v.PREFIX_PARTS,
            "feedback": v.FEEDBACK_PREFIX + "合成回归证据，仅验证验签器契约。",
            "markers": [
                {"source": "human_annotation", "truthSha256": v.TRUTH_SHA256, "word": word,
                 "start": start, "end": end}
                for word, start, end in v.ANCHORS
            ],
        }
        self.write("checkpoint-7.json", self.output)
        self.c_report = {
            "stage": "C", "runId": self.c_run, "fence": 3, "previousFence": 2,
            "nextIndexBefore": v.PREFIX_PARTS + 1, "nextIndex": v.PREFIX_PARTS + 2,
            "prefixSha256": PREFIX_SHA, "outputIndex": v.PREFIX_PARTS + 1,
            "outputSha256": sha256((root / "checkpoint-7.json").read_bytes()).hexdigest(),
            "coldResumedEqual": True, "resumedOnlyWindows": 851,
            "feedback": self.output["feedback"], "quote": "[原声录音]",
            "receipt": {"outputSha256": COLD_SHA, "outputIndex": v.PREFIX_PARTS + 1,
                        "runId": self.c_run, "fence": 3, "savedAt": 123},
            "duplicateReplay": {"duplicate": True, "savedAt": 123},
            "staleFenceRejected": True,
        }
        automation = "Automation_c2ca080ec67481919b9db50329e9e943"
        input_bytes = 441_322
        self.offline = {
            "isolated": True, "recordingSha256": v.RECORDING_SHA256, "inputBytes": input_bytes,
            "runs": [
                {"step": step, "officialRunId": run_id, "automationId": automation,
                 "fence": fence, "startedAt": f"2026-11-13T00:0{fence}:00Z",
                 "endedAt": f"2026-11-13T00:0{fence}:30Z",
                 "recordingSha256": v.RECORDING_SHA256, "inputBytes": input_bytes}
                for step, run_id, fence in (("A", self.a_run, 1), ("B", self.b_run, 2), ("C", self.c_run, 3))
            ],
        }
        event_rows = []
        for step, run_id, fence in (("A", self.a_run, 1), ("B", self.b_run, 2), ("C", self.c_run, 3)):
            for index, event_type in enumerate(v.WORK_EVENTS[step], start=1):
                event = {"officialRunId": run_id, "fence": fence, "type": event_type,
                         "automationId": automation, "isolated": True, "source": "cloud",
                         "at": f"2026-11-13T00:0{fence}:{index:02d}Z"}
                if event_type == "recording_verified":
                    event.update(bytes=input_bytes, sha256=v.RECORDING_SHA256)
                event_rows.append(event)
        self.site = {"events": event_rows}
        self.write("offline.json", self.offline)
        self.write("site-event-export.json", self.site)
        self.write("stage-a.json", self.a_report)
        self.write("stage-b.json", self.b_report)
        self.write("stage-c.json", self.c_report)
        self.write("status.json", {
            "pendingAcoustics": [{"jobId": "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710",
                                  "nextIndex": 0, "retryReason": "recording_read_failed"}],
            "subscriptionActive": True,
        })
        base = datetime(2026, 11, 13, tzinfo=timezone.utc)
        self.history = {
            "emptyQueueWakes": [
                {"utc": (base + timedelta(seconds=offset)).isoformat(), "pendingCount": 0,
                 "pendingAcoustics": 0, "subscriptionActive": True}
                for offset in (0, 43_200, 86_400)
            ],
            "officialRefs": {
                stage: {"userTurnId": str(uuid.uuid4()), "assistantMessageId": str(uuid.uuid4()),
                        "turnKey": f"turn-{stage}"}
                for stage in ("A", "B", "C")
            },
        }
        self.history["automationId"] = "Automation_c2ca080ec67481919b9db50329e9e943"
        self.history["runs"] = [
            {"officialRunId": run_id, "taskId": "task-g5", "automationId": "Automation_c2ca080ec67481919b9db50329e9e943",
             "startedAt": f"2026-11-13T00:0{fence}:00Z", "endedAt": f"2026-11-13T00:0{fence}:30Z",
             "officialRecordRef": f"fixture-{step}", "source": "scheduled-cloud",
             "clientExecution": False, "approvalPrompts": 0, "quotaObservation": "fixture quota"}
            for step, run_id, fence in (("A", self.a_run, 1), ("B", self.b_run, 2), ("C", self.c_run, 3))
        ]
        self.write("official-run-history.json", self.history)
        self.args = {
            "metadata": str(root / "checkpoint-0.json"),
            "parts_dir": str(root),
            "output": str(root / "checkpoint-7.json"),
            "cold": str(root / "cold.bin"),
            "resumed": str(root / "resumed.bin"),
            "report": str(root / "stage-c.json"),
            "history": str(root / "official-run-history.json"),
        }

    def write(self, name: str, value) -> None:
        path = self.root / name
        if isinstance(value, bytes):
            path.write_bytes(value)
        else:
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


class VerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.evidence = Evidence(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_valid_stages_and_bundle(self) -> None:
        e = self.evidence
        self.assertEqual(run("stage-a", "--report", str(self.root / "stage-a.json"),
                             "--status", str(self.root / "status.json")), 0)
        self.assertEqual(run("stage-b", "--metadata", e.args["metadata"],
                             "--parts-dir", e.args["parts_dir"],
                             "--report", str(self.root / "stage-b.json"),
                             "--offline", str(self.root / "offline.json"),
                             "--site-events", str(self.root / "site-event-export.json"),
                             "--history", str(self.root / "official-run-history.json")), 0)
        self.assertEqual(run("stage-c", "--metadata", e.args["metadata"],
                             "--parts-dir", e.args["parts_dir"],
                             "--output", e.args["output"], "--cold", e.args["cold"],
                             "--resumed", e.args["resumed"], "--report", e.args["report"],
                             "--history", e.args["history"],
                             "--offline", str(self.root / "offline.json"),
                             "--site-events", str(self.root / "site-event-export.json")), 0)
        self.assertEqual(run("bundle", "--dir", str(self.root)), 0)

    def test_recipe_matches_canonical_v26_description(self) -> None:
        self.assertEqual(v.RECIPE_SHA256,
                         "9022a23414fc0201753c3a06e81209d058c9ae0fbe5c6dff5893042e909e95c2")

    def test_cold_resumed_mismatch_fails_hard_gate(self) -> None:
        e = self.evidence
        (self.root / "resumed.bin").write_bytes(COLD[:-1] + b"\x00")
        self.assertNotEqual(run("stage-c", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--output", e.args["output"], "--cold", e.args["cold"],
                                "--resumed", e.args["resumed"], "--report", e.args["report"]), 0)

    def test_v24_model_rejected(self) -> None:
        e = self.evidence
        meta = dict(e.metadata, modelSha256=v.V24_MODEL_SHA256)
        (self.root / "checkpoint-0.json").write_text(json.dumps(meta), encoding="utf-8")
        self.assertNotEqual(run("stage-b", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--report", str(self.root / "stage-b.json")), 0)

    def test_v24_prefix_bytes_rejected(self) -> None:
        e = self.evidence
        meta = dict(e.metadata, prefixBytes=v.V24_PREFIX_BYTES)
        (self.root / "checkpoint-0.json").write_text(json.dumps(meta), encoding="utf-8")
        self.assertNotEqual(run("stage-b", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--report", str(self.root / "stage-b.json")), 0)

    def test_v24_prefix_sha_rejected(self) -> None:
        e = self.evidence
        meta = dict(e.metadata, prefixSha256=v.V24_PREFIX_SHA256)
        (self.root / "checkpoint-0.json").write_text(json.dumps(meta), encoding="utf-8")
        self.assertNotEqual(run("stage-b", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--report", str(self.root / "stage-b.json")), 0)

    def test_missing_part_rejected(self) -> None:
        e = self.evidence
        (self.root / "checkpoint-6.bin").unlink()
        self.assertNotEqual(run("stage-b", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--report", str(self.root / "stage-b.json")), 0)

    def test_oversized_part_rejected(self) -> None:
        e = self.evidence
        (self.root / "checkpoint-6.bin").write_bytes(PARTS[-1] + b"\x00" * 200)
        self.assertNotEqual(run("stage-b", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--report", str(self.root / "stage-b.json")), 0)

    def test_feedback_prefix_required(self) -> None:
        e = self.evidence
        output = dict(e.output, feedback="缺少固定免责前缀的反馈，长度足够但不符合契约。")
        (self.root / "checkpoint-7.json").write_text(json.dumps(output), encoding="utf-8")
        self.assertNotEqual(run("stage-c", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--output", e.args["output"], "--cold", e.args["cold"],
                                "--resumed", e.args["resumed"], "--report", e.args["report"]), 0)

    def test_marker_source_required(self) -> None:
        e = self.evidence
        markers = [dict(marker) for marker in e.output["markers"]]
        markers[0]["source"] = "model"
        output = dict(e.output, markers=markers)
        (self.root / "checkpoint-7.json").write_text(json.dumps(output), encoding="utf-8")
        self.assertNotEqual(run("stage-c", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--output", e.args["output"], "--cold", e.args["cold"],
                                "--resumed", e.args["resumed"], "--report", e.args["report"]), 0)

    def test_manifest_cold_resumed_mismatch_rejected(self) -> None:
        e = self.evidence
        output = dict(e.output, resumedOutputSha256=sha256(b"other").hexdigest())
        (self.root / "checkpoint-7.json").write_text(json.dumps(output), encoding="utf-8")
        self.assertNotEqual(run("stage-c", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--output", e.args["output"], "--cold", e.args["cold"],
                                "--resumed", e.args["resumed"], "--report", e.args["report"]), 0)

    def test_pty_line_over_3000_rejected(self) -> None:
        e = self.evidence
        report = dict(e.c_report, ptyLines=["x" * 3001])
        (self.root / "stage-c.json").write_text(json.dumps(report), encoding="utf-8")
        self.assertNotEqual(run("stage-c", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--output", e.args["output"], "--cold", e.args["cold"],
                                "--resumed", e.args["resumed"], "--report", e.args["report"]), 0)

    def g5_stage_c(self) -> int:
        e = self.evidence
        return run("stage-c", "--metadata", e.args["metadata"],
                   "--parts-dir", e.args["parts_dir"],
                   "--output", e.args["output"], "--cold", e.args["cold"],
                   "--resumed", e.args["resumed"], "--report", e.args["report"],
                   "--history", e.args["history"],
                   "--offline", str(self.root / "offline.json"),
                   "--site-events", str(self.root / "site-event-export.json"))

    def test_offline_isolated_false_rejected(self) -> None:
        offline = dict(self.evidence.offline, isolated=False)
        (self.root / "offline.json").write_text(json.dumps(offline), encoding="utf-8")
        self.assertNotEqual(self.g5_stage_c(), 0)

    def test_offline_run_missing_automation_rejected(self) -> None:
        runs = [dict(row) for row in self.evidence.offline["runs"]]
        runs[1].pop("automationId")
        offline = dict(self.evidence.offline, runs=runs)
        (self.root / "offline.json").write_text(json.dumps(offline), encoding="utf-8")
        self.assertNotEqual(self.g5_stage_c(), 0)

    def test_recording_verified_missing_sha_rejected(self) -> None:
        events = [dict(row) for row in self.evidence.site["events"]]
        for event in events:
            if event["type"] == "recording_verified":
                event.pop("sha256")
        (self.root / "site-event-export.json").write_text(
            json.dumps({"events": events}), encoding="utf-8")
        self.assertNotEqual(self.g5_stage_c(), 0)

    def test_recording_verified_bytes_mismatch_rejected(self) -> None:
        events = [dict(row) for row in self.evidence.site["events"]]
        for event in events:
            if event["type"] == "recording_verified":
                event["bytes"] = 100
        (self.root / "site-event-export.json").write_text(
            json.dumps({"events": events}), encoding="utf-8")
        self.assertNotEqual(self.g5_stage_c(), 0)

    def test_history_automation_mismatch_rejected(self) -> None:
        history = json.loads((self.root / "official-run-history.json").read_text(encoding="utf-8"))
        history["runs"][1]["automationId"] = "different-automation"
        (self.root / "official-run-history.json").write_text(json.dumps(history), encoding="utf-8")
        self.assertNotEqual(self.g5_stage_c(), 0)

    def test_history_span_and_subscription_required(self) -> None:
        e = self.evidence
        short = dict(e.history, emptyQueueWakes=[
            {"utc": "2026-11-13T00:00:00+00:00", "pendingCount": 0,
             "pendingAcoustics": 0, "subscriptionActive": False},
            {"utc": "2026-11-13T00:00:01+00:00", "pendingCount": 0,
             "pendingAcoustics": 0, "subscriptionActive": True},
            {"utc": "2026-11-13T00:00:02+00:00", "pendingCount": 0,
             "pendingAcoustics": 0, "subscriptionActive": True},
        ])
        (self.root / "official-run-history.json").write_text(json.dumps(short), encoding="utf-8")
        self.assertNotEqual(run("stage-c", "--metadata", e.args["metadata"],
                                "--parts-dir", e.args["parts_dir"],
                                "--output", e.args["output"], "--cold", e.args["cold"],
                                "--resumed", e.args["resumed"], "--report", e.args["report"],
                                "--history", e.args["history"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)