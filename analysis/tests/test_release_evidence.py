from array import array
import base64
import copy
from hashlib import sha256
import json
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from verify_release import (
    NAMESPACE, ROLES, SUBJECT, read_json, utc, verify_browser_playback, verify_checkpoint_file, verify_inference,
    verify_offline_inference, verify_offline_output, verify_platform_probes, verify_signatures, verify_work_runs,
)
from bandroom_acoustic.checkpoint import encode_checkpoint
from bandroom_acoustic.decode import DecodedAudio


def stamp(time):
    return f"2026-11-10T{time}:00Z"


def offline_fixture():
    learner = {"revision": 12, "day": 12, "stage": "followup", "completed": 11, "finished": False}
    offline = {
        "schemaVersion": 1, "jobState": "completed", "feedbackVisible": True, "duplicateFeedbackCount": 1,
        "macOnlineAt": stamp("09:01"), "approvalPrompts": 0,
        "macProbes": {"httpsAttempts": 12, "httpsFailures": 12, "routeAttempts": 6, "routeFailures": 6},
        "learnerState": {"before": learner.copy(), "after": learner.copy()},
        "jobId": "job", "taskId": "task", "attemptId": "attempt", "attemptRevision": 3, "recordingId": "audio",
        "recordingSha256": "a" * 64, "inputBytes": 10, "analysisVersion": "test-v1",
        "offlineStart": stamp("07:00"), "offlineEnd": stamp("09:00"),
        "browser": {"closedAt": stamp("06:55"), "reopenedAt": stamp("09:05"),
                    "attemptId": "attempt", "feedbackId": "feedback",
                    "playback": {"recordingId": "audio", "startMs": 100, "observedCurrentTimeMs": 120,
                                 "toleranceMs": 150}},
    }
    subject = {key: offline[key] for key in SUBJECT}
    official = {"automationId": "schedule", "runs": []}
    offline["runs"] = []
    for fence, (start, end) in enumerate((("06:40", "06:50"), ("07:10", "07:30"), ("08:10", "08:40")), 1):
        run = {"officialRunId": f"official-{fence}", "clientRunId": f"client-{fence}", "fences": [fence],
               "startedAt": stamp(start), "endedAt": stamp(end)}
        offline["runs"].append({**run, "stages": [["claim"], ["decode"], ["decode", "finalize"]][fence - 1]})
        official["runs"].append({**run, "subject": subject.copy(), "source": "scheduled-cloud",
                                 "automationId": "schedule", "approvalPrompts": 0})

    def event(fence, time, tool, outcome="ok", stage=None, **meta):
        return {"clientRunId": f"client-{fence}", "taskId": "task", "fence": fence, "at": stamp(time),
                "tool": tool, "outcome": outcome, "stage": stage, "metadata": meta}

    next_at = int(utc(stamp("07:10")).timestamp() * 1000)
    offline["beforeOfflineEvents"] = [
        event(1, "06:40", "claim_review_tasks"),
        event(1, "06:41", "read_review_recording", "error", code="recording_read_failed"),
        event(1, "06:42", "fail_review_task", "retry_wait", code="recording_read_failed", nextAt=next_at),
    ]
    checkpoint = {"analysisVersion": "test-v1", "chunkIndex": 0, "bytes": 4, "artifactSha256": "b" * 64,
                  "inputSha256": offline["recordingSha256"], "inputBytes": 10, "transport": "binary-v1"}
    blob = {"recordingId": "audio", "sha256": offline["recordingSha256"], "total": 10}
    completion = {"receiptId": "receipt", "feedbackId": "feedback"}
    offline["serverEvents"] = [
        event(2, "07:10", "claim_review_tasks"),
        event(2, "07:11", "read_review_recording", offset=0, length=4, **blob),
        event(2, "07:12", "read_review_recording", offset=4, length=6, **blob),
        event(2, "07:14", "save_review_checkpoint", stage="decode", **checkpoint),
        event(3, "08:10", "claim_review_tasks"),
        event(3, "08:11", "read_review_checkpoint", stage="decode", **checkpoint),
        event(3, "08:14", "complete_review_task", stage="finalize", **completion),
        event(3, "08:15", "read_review_receipt", stage="finalize", **completion),
    ]
    official["runs"][1].update(disposition="interrupted", originalAudio={
        "bytes": 10, "computedSha256": offline["recordingSha256"], "verifiedAt": stamp("07:13"),
    })
    official["runs"][2].update(completionResponseLost=True, checkpointVerifiedAt=stamp("08:12"),
                                verifiedCheckpointSha256=checkpoint["artifactSha256"])
    offline["feedbackReceipt"] = {**subject, "fence": 3, "outputSha256": "d" * 64,
                                  "createdAt": stamp("08:13"), "id": "receipt", "feedbackId": "feedback"}
    official["soak"] = {
        "startedAt": stamp("07:00"), "endedAt": "2026-11-11T08:00:00Z",
        "wakeups": [{"officialRunId": f"soak-{hour}", "source": "scheduled-cloud", "approvalPrompts": 0,
                     "automationId": "schedule", "startedAt": stamp(f"{hour}:00"), "endedAt": stamp(f"{hour}:02")}
                    for hour in (11, 14, 17)],
    }
    times = ("07:00", "07:10", "07:20", "07:30", "07:40", "07:50",
             "08:00", "08:10", "08:20", "08:30", "08:40", "08:50")
    probes = {
        "https": [{"at": stamp(time), "outcome": "connection-failed"} for time in times],
        "route": [{"at": stamp(time), "outcome": "no-default-route"} for time in times[::2]],
    }
    return offline, official, probes


def playback_events(start, stop):
    return [
        {"type": "seeked", "elapsedMs": 100, "mediaTimeMs": start},
        {"type": "playing", "elapsedMs": 101, "mediaTimeMs": start},
        {"type": "timeupdate", "elapsedMs": 150, "mediaTimeMs": start + 49},
        {"type": "pause", "elapsedMs": 101 + stop - start, "mediaTimeMs": stop},
    ]


class ReleaseEvidenceTest(unittest.TestCase):
    def test_offline_fixture_also_passes_frozen_checker_when_available(self):
        checker = Path(__file__).resolve().parents[3] / "delivery-d2" / "check_offline_acceptance.py"
        if not checker.is_file():
            self.skipTest("historical delivery kit is kept outside Git")
        offline, official, probes = offline_fixture()
        verify_work_runs(offline, official, probes)
        report = runpy.run_path(str(checker))["validate"](offline)
        self.assertEqual(report.failures(), [])
    def test_same_task_retry_with_verified_bytes_checkpoint_and_receipt(self):
        offline, official, probes = offline_fixture()
        verify_work_runs(offline, official, probes)
        offline["serverEvents"].append(copy.deepcopy(offline["serverEvents"][1]))
        verify_work_runs(offline, official, probes)

    def test_rejects_evidence_gaps(self):
        cases = (
            (lambda a, b, c: b["runs"][1].update(source="interactive"), "cloud run identity"),
            (lambda a, b, c: b["runs"][1].update(approvalPrompts=1), "cloud run identity"),
            (lambda a, b, c: b["runs"][1]["subject"].update(attemptId="another"), "its task"),
            (lambda a, b, c: a["serverEvents"][5].update(fence=2), "lease fence"),
            (lambda a, b, c: a["serverEvents"].append(a["beforeOfflineEvents"].pop()), "misclassified"),
            (lambda a, b, c: [event["metadata"].update(code="recording_missing")
                              for event in a["beforeOfflineEvents"][1:]], "retry state"),
            (lambda a, b, c: a["serverEvents"][2]["metadata"].update(length=5), "every byte"),
            (lambda a, b, c: a["serverEvents"][5]["metadata"].pop("transport"), "binary decode checkpoint"),
            (lambda a, b, c: b["runs"][2].update(verifiedCheckpointSha256="c" * 64), "decode checkpoint"),
            (lambda a, b, c: a["feedbackReceipt"].update(createdAt=stamp("08:11")), "causal"),
            (lambda a, b, c: a["serverEvents"][-1]["metadata"].update(receiptId="different"), "same receipt"),
            (lambda a, b, c: c["route"].pop(), "offline route probes"),
            (lambda a, b, c: b["soak"].update(endedAt=stamp("18:00")), "24-hour soak"),
        )
        for mutate, message in cases:
            with self.subTest(message=message):
                fixture = offline_fixture()
                mutate(*fixture)
                with self.assertRaisesRegex(ValueError, message):
                    verify_work_runs(*fixture)

    def test_checkpoint_requires_artifact_bytes_and_same_timeline(self):
        offline, official, probes = offline_fixture()
        sample_count = 480000
        expected = DecodedAudio(
            path="fixture", input_sha256=offline["recordingSha256"], input_bytes=offline["inputBytes"],
            container="webm", codec="opus", source_rate=48000, source_channels=1, sample_rate=16000,
            sample_count=sample_count, container_duration_ms=30000, decoded_duration_ms=30000,
            priming_ms=0, samples=array("h", [1]) * sample_count,
        )
        data = encode_checkpoint(expected, offline["analysisVersion"])
        artifact_sha = sha256(data).hexdigest()
        for index in (3, 5):
            offline["serverEvents"][index]["metadata"].update(artifactSha256=artifact_sha, bytes=len(data))
        official["runs"][2]["verifiedCheckpointSha256"] = artifact_sha
        checkpoint = verify_work_runs(offline, official, probes)
        output = {"analysis": {"decoded": {"sampleRateHz": 16000, "sampleCount": sample_count},
                               "coverage": {"analyzedSamples": [[0, sample_count]]}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.bin"
            with self.assertRaises(FileNotFoundError):
                verify_checkpoint_file(path, checkpoint, offline, output)
            path.write_bytes(data)
            decoded = verify_checkpoint_file(path, checkpoint, offline, output)
            self.assertEqual(decoded.samples, expected.samples)
            output["analysis"]["decoded"]["sampleCount"] -= 1
            with self.assertRaisesRegex(ValueError, "checkpoint's timeline"):
                verify_checkpoint_file(path, checkpoint, offline, output)
            output["analysis"]["decoded"]["sampleCount"] += 1
            path.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
            with self.assertRaisesRegex(ValueError, "artifact digest"):
                verify_checkpoint_file(path, checkpoint, offline, output)

        hashes = {"model-weights.bin": "e" * 64, "analysis-config.json": "f" * 64}
        run = official["runs"][2]
        window = {"chunkIndex": 0, "startSample": 0, "endSample": sample_count,
                  "inputPcmSha256": sha256(b"\x01\x00" * sample_count).hexdigest()}
        model_output = json.dumps({**window, "result": {"phones": ["TH", "S"]}}).encode()
        evidence = {**{key: offline[key] for key in SUBJECT}, "fence": 3, "clientRunId": run["clientRunId"],
                    "checkpointSha256": artifact_sha, "weightsSha256": hashes["model-weights.bin"],
                    "configSha256": hashes["analysis-config.json"],
                    "outputSha256": offline["feedbackReceipt"]["outputSha256"],
                    "startedAt": stamp("08:12"), "endedAt": stamp("08:13"),
                    "windows": [{**window, "state": "inferred", "outputSha256": sha256(model_output).hexdigest(),
                                 "outputBase64": base64.b64encode(model_output).decode()}]}
        verify_offline_inference(evidence, offline, run, checkpoint, decoded, output, hashes)
        with self.assertRaisesRegex(ValueError, "complete recovered audio"):
            verify_offline_inference({**evidence, "windows": []}, offline, run, checkpoint, decoded, output, hashes)
        for values, message in (
            ({"outputBase64": ""}, "missing offline inference window artifact"),
            ({"inputPcmSha256": "0" * 64}, "recovered PCM samples"),
            ({"outputSha256": "0" * 64}, "window artifact digest"),
        ):
            modified = {**evidence, "windows": [{**evidence["windows"][0], **values}]}
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                verify_offline_inference(modified, offline, run, checkpoint, decoded, output, hashes)

    def test_only_completed_inference_counts_as_coverage(self):
        clip = {"clipId": "clip", "audioSha256": "a" * 64, "sampleCount": 100, "sampleRateHz": 16000}
        labels = {"clips": [clip]}
        predictions = {"clips": [{**clip, "analyzedSamples": [[0, 100]]}]}
        manifest = dict(sourceSha="source", buildSha256="build", analysisVersion="version",
                        environmentId="isolated", route="A")
        windows = [
            {"chunkIndex": index, "startSample": start, "endSample": end,
             "state": "inferred", "outputSha256": "b" * 64}
            for index, (start, end) in enumerate(((0, 60), (50, 100)))
        ]
        evidence = {**manifest, "clips": [{**clip, "windows": windows}]}
        verify_inference(evidence, predictions, labels, manifest)
        windows[1]["startSample"] = 61
        with self.assertRaisesRegex(ValueError, "claimed coverage"):
            verify_inference(evidence, predictions, labels, manifest)
        windows[1].update(startSample=50, state="decoded")
        with self.assertRaisesRegex(ValueError, "completed inference window"):
            verify_inference(evidence, predictions, labels, manifest)

    def test_receipt_needs_real_acoustic_event_at_annotated_time(self):
        offline, _, _ = offline_fixture()
        event = {"wordIndex": 2, "phoneIndex": 0, "kind": "substitution", "target": "TH",
                 "actual": "S", "startMs": 100, "endMs": 200}
        reference = {**{key: offline[key] for key in SUBJECT}, "reviewerId": "human", "errors": [event.copy()]}
        output = {"analysis": {"schemaVersion": 1, "state": "completed",
                               "analysisVersion": offline["analysisVersion"], "inputSha256": offline["recordingSha256"],
                               "decoded": {"sampleRateHz": 16000, "sampleCount": 480000},
                               "coverage": {"analyzedSamples": [[0, 480000]]}, "errors": [event]}}
        verify_offline_output(output, reference, offline, "d" * 64)
        with self.assertRaisesRegex(ValueError, "this receipt"):
            verify_offline_output(output, reference, offline, "e" * 64)
        offline["browser"]["playback"]["startMs"] = 101
        with self.assertRaisesRegex(ValueError, "verified error"):
            verify_offline_output(output, reference, offline, "d" * 64)
        offline["browser"]["playback"]["startMs"] = 100
        event["endMs"] = 351
        with self.assertRaisesRegex(ValueError, "verified error"):
            verify_offline_output(output, reference, offline, "d" * 64)

    def test_browser_playback_needs_same_receipt_and_native_timing(self):
        offline, _, _ = offline_fixture()
        event = {"wordIndex": 2, "phoneIndex": 0, "kind": "substitution", "target": "TH",
                 "actual": "S", "startMs": 2000, "endMs": 2200}
        browser = {"browsers": {"Chrome": {"version": "146"}, "Safari": {"version": "26"}}}
        reviews, markers = {}, []
        for name, encoding, digest in (("Chrome", "webm/opus", "b" * 64), ("Safari", "mp4/aac", "c" * 64)):
            version = browser["browsers"][name]["version"]
            reviews[name] = {**{key: offline[key] for key in SUBJECT}, "version": version, "feedbackId": "feedback",
                             "receiptId": "receipt", "error": event, "reviewerId": "human", "heardWord": "think",
                             "heardActual": "S", "events": playback_events(1500, 2700)}
            markers.append({"browser": name, "version": version, "encoding": encoding, "recordingSha256": digest,
                            "durationMs": 30000, "markers": [
                                {"position": position, "startMs": start, "stopMs": start + 400,
                                 "events": playback_events(start, start + 400)}
                                for position, start in (("first", 100), ("middle", 15000), ("tail", 29000))]})
        raw = {"reviews": reviews, "timelineChecks": markers}
        human = {**event, "word": "think"}
        verify_browser_playback(raw, browser, offline, event, human, 30000)
        broken = copy.deepcopy(raw)
        broken["reviews"]["Safari"]["receiptId"] = "other"
        with self.assertRaisesRegex(ValueError, "original answer and error receipt"):
            verify_browser_playback(broken, browser, offline, event, human, 30000)
        broken = copy.deepcopy(raw)
        broken["reviews"]["Chrome"]["events"][0]["mediaTimeMs"] = 2000
        with self.assertRaisesRegex(ValueError, "browser seek"):
            verify_browser_playback(broken, browser, offline, event, human, 30000)
        broken = copy.deepcopy(raw)
        broken["timelineChecks"][1]["markers"].pop()
        with self.assertRaisesRegex(ValueError, "timeline markers"):
            verify_browser_playback(broken, browser, offline, event, human, 30000)
        broken = copy.deepcopy(raw)
        broken["timelineChecks"][1]["recordingSha256"] = broken["timelineChecks"][0]["recordingSha256"]
        with self.assertRaisesRegex(ValueError, "distinct original recordings"):
            verify_browser_playback(broken, browser, offline, event, human, 30000)

    def test_cloud_probes_need_both_lengths_encodings_and_distinct_resume(self):
        offline, _, _ = offline_fixture()
        evidence = {"officialHistorySha256": "d" * 64, "probes": [],
                    "receiptProbe": {"officialRunId": "probe-resume", "kind": "writing", "taskId": "text-fixture",
                                     "receiptId": "text-receipt", "readbackReceiptId": "text-receipt"}}
        for encoding in ("webm/opus", "mp4/aac"):
            for span, duration in (("short", 30000), ("near-limit", 177000)):
                index = len(evidence["probes"])
                task, recording, checkpoint = f"probe-{index}", str(index) * 64, str(index + 4) * 64
                run = {"taskId": task, "source": "scheduled-cloud", "automationId": "probe-automation",
                       "approvalPrompts": 0, "quotaObservation": "within existing plan",
                       "checkpointBytes": 960000, "checkpointSha256": checkpoint}
                evidence["probes"].append({
                    "encoding": encoding, "span": span, "durationMs": duration,
                    "taskId": task, "recordingSha256": recording, "recordingBytes": 99999,
                    "readRun": {**run, "officialRunId": "probe-read", "fence": 1,
                                "startedAt": stamp("04:00"), "endedAt": stamp("04:10"),
                                "readBytes": 99999, "computedSha256": recording, "decoderInputSha256": recording},
                    "resumeRun": {**run, "officialRunId": "probe-resume", "fence": 2,
                                  "startedAt": stamp("04:30"), "endedAt": stamp("04:34"),
                                  "computedCheckpointSha256": checkpoint},
                    "faults": {"shortReadBytes": 100, "shortReadRejected": True, "recoveredSha256": recording,
                               "expiredRejected": True, "refreshedSucceeded": True},
                })
        verify_platform_probes(evidence, offline, "d" * 64)
        for key, changes, reason in (
            ("", {"durationMs": 30000}, "invalid or reused"),
            ("resumeRun", {"officialRunId": "probe-read"}, "independent cloud record"),
            ("resumeRun", {"approvalPrompts": 1}, "independent cloud record"),
            ("resumeRun", {"computedCheckpointSha256": "f" * 64}, "read back the checkpoint"),
            ("faults", {"expiredRejected": False}, "expired access"),
        ):
            with self.subTest(changes=changes):
                broken = copy.deepcopy(evidence)
                row = broken["probes"][1]
                (row[key] if key else row).update(changes)
                with self.assertRaisesRegex(ValueError, reason):
                    verify_platform_probes(broken, offline, "d" * 64)
        broken = copy.deepcopy(evidence)
        broken["receiptProbe"]["readbackReceiptId"] = "other"
        with self.assertRaisesRegex(ValueError, "isolated text write"):
            verify_platform_probes(broken, offline, "d" * 64)
        evidence["probes"].pop()
        with self.assertRaisesRegex(ValueError, "both browser encodings"):
            verify_platform_probes(evidence, offline, "d" * 64)

    def test_rejects_ambiguous_json(self):
        for invalid in ('{"a": 1, "a": 2}', '{"a": NaN}', '{"a": 1e999}'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                read_json(invalid)

    @unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH is needed")
    def test_distinct_detached_signatures_are_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bundle = root / "bundle"
            bundle.mkdir()
            manifest = bundle / "manifest.json"
            manifest.write_bytes(b'{"route":"A"}')
            allowed = root / "trusted_signers"
            lines = []
            for role in ROLES:
                key = root / role
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
                pub = key.with_suffix(".pub").read_text().split()
                lines.append(" ".join([role, *pub[:2]]))
                subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(key), "-n", NAMESPACE, str(manifest)],
                               capture_output=True, check=True)
                manifest.with_suffix(".json.sig").rename(bundle / f"{role}.sig")
            allowed.write_text("\n".join(lines) + "\n")
            verify_signatures(bundle, manifest.read_bytes(), allowed)
            with self.assertRaisesRegex(ValueError, "invalid release manifest signature"):
                verify_signatures(bundle, b'{"route":"B"}', allowed)
            lines[-1] = ROLES[-1] + " " + lines[0].split(maxsplit=1)[1]
            allowed.write_text("\n".join(lines) + "\n")
            with self.assertRaisesRegex(ValueError, "distinct pre-established trust keys"):
                verify_signatures(bundle, manifest.read_bytes(), allowed)
