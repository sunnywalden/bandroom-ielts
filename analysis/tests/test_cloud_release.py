import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from verify_cloud_release import CANDIDATE, NAMESPACE, WORK_EVENTS, verify_source, verify_work
from verify_release import ROLES, verify_signatures


def recovery_fixture():
    origin = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def at(seconds):
        return (origin + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")

    subject = {
        **{key: key for key in CANDIDATE},
        "jobId": "job", "taskId": "task", "attemptId": "attempt", "attemptRevision": 1,
        "recordingId": "recording", "recordingSha256": "a" * 64, "inputBytes": 100,
    }

    def run_fields(run_id, task_id, start):
        return {
            "officialRunId": run_id, "taskId": task_id, "automationId": "schedule",
            "startedAt": at(start), "endedAt": at(start + 10), "officialRecordRef": "fixture-" + run_id,
            "source": "scheduled-cloud", "clientExecution": False, "approvalPrompts": 0,
            "quotaObservation": "fixture quota",
        }

    runs, events, records = [], [], []
    event_fields = {
        "retry_wait": {"reason": "recording_read_failed", "nextAttemptAt": at(30)},
        "recording_verified": {"bytes": 100, "sha256": "a" * 64},
        "interrupted": {"recoverableAt": at(60)},
        "feedback_committed": {"responseLost": True, "receiptId": "receipt"},
        "receipt_readback": {"receiptId": "receipt", "feedbackId": "feedback", "outputSha256": "b" * 64},
    }
    for fence, (step, steps) in enumerate(zip("ABC", WORK_EVENTS, strict=True), 1):
        run_id, start = "run-" + step, fence * 20
        record = run_fields(run_id, "task", start)
        run = {**subject, **record, "step": step, "fence": fence}
        runs.append(run)
        records.append(record)
        for second, event_type in enumerate(steps, 1):
            events.append({**subject, "officialRunId": run_id, "fence": fence, "type": event_type,
                           "source": "cloud", "at": at(start + second), **event_fields.get(event_type, {})})
    workers = [
        {**subject, "officialRunId": record["officialRunId"], "executionId": "exec-" + record["officialRunId"],
         "source": "cloud-executor", "localExecution": False, "startedAt": record["startedAt"],
         "endedAt": record["endedAt"], "fence": record["fence"]}
        for record in runs[1:]
    ]
    cold = run_fields("cold", "task", 100)
    fair = run_fields("fair", "later", 120)
    records.extend((cold, fair))
    workers[0].update(readBytes=100, computedSha256="a" * 64, decoderInputSha256="a" * 64)
    workers.append({**subject, **cold, "source": "cloud-executor", "executionId": "exec-cold", "readOnly": True,
                    "localExecution": False, "cacheEmpty": True, "restoredChunks": [], "readBytes": 100,
                    "decoderInputSha256": "a" * 64})
    receipt = {**subject, "fence": 3, "id": "receipt", "feedbackId": "feedback", "outputSha256": "b" * 64}
    offline = {
        **subject, "isolated": True, "runs": runs, "page": {
            "browser": "Chrome", "closedAt": at(10), "reopenedAt": at(90),
            "closeReceipt": "fixture-close", "reopenReceipt": "fixture-reopen",
        },
        "feedbackReceipt": receipt, "jobState": "completed", "duplicateFeedbackCount": 1, "feedbackVisible": True,
        "fairness": {"officialRunId": "fair", "blockedTaskId": "blocked", "laterTaskId": "later",
                     "blockedTaskRetried": True, "laterTaskCompleted": True},
    }
    history = {"automationId": "schedule", "runs": records, "emptyQueueWakes": [
        {**run_fields(f"wake-{index}", "empty", 200 + index * 43200), "discoveredCount": 0, "createdCount": 0}
        for index in range(3)
    ]}
    site = {"events": events, "clientOperationsDuringClosure": [], "feedbackReceipt": receipt.copy()}
    return offline, history, site, {"runs": workers}, {"coldRunId": "cold"}


class CloudReleaseTests(unittest.TestCase):
    def test_independent_runs_correlate_to_the_same_isolated_attempt(self):
        prefix, resume, workers, records = verify_work(*recovery_fixture())
        self.assertEqual(prefix["checkpoint_saved"]["fence"], 2)
        self.assertEqual(resume["receipt_readback"]["fence"], 3)
        self.assertEqual(workers[2]["officialRunId"], "cold")
        self.assertEqual(records["run-C"]["taskId"], "task")

    def test_rejects_unattended_recovery_evidence_regressions(self):
        fixture = recovery_fixture()
        changes = (
            (1, ("runs", 0, "approvalPrompts"), 1, "unattended recovery"),
            (0, ("runs", 2, "recordingSha256"), "c" * 64, "unattended recovery"),
            (0, ("page", "reopenedAt"), fixture[0]["runs"][2]["startedAt"], "page did not stay closed"),
            (2, ("events", 1, "nextAttemptAt"), fixture[0]["runs"][2]["startedAt"], "retry must be registered"),
            (2, ("events", -3, "type"), "decoded", "expected cloud events"),
            (2, ("events", -1, "receiptId"), "different", "original feedback receipt"),
            (3, ("runs", 1, "localExecution"), True, "cloud executor receipt"),
            (3, ("runs", 0, "readBytes"), 99, "full original audio"),
            (1, ("runs", -1, "taskId"), "other", "queue fairness"),
            (1, ("emptyQueueWakes", -1, "startedAt"), fixture[1]["emptyQueueWakes"][1]["startedAt"], "24 hours"),
        )
        for part, path, value, reason in changes:
            with self.subTest(reason=reason):
                modified = copy.deepcopy(fixture)
                container = modified[part]
                for key in path[:-1]:
                    container = container[key]
                container[path[-1]] = value
                with self.assertRaisesRegex(ValueError, reason):
                    verify_work(*modified)

    @unittest.skipUnless(shutil.which("git"), "Git is needed")
    def test_release_tree_matches_staged_candidate_and_rejects_dirty_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)

            def git(*args):
                return subprocess.run(["git", "-C", temp, *args], capture_output=True, text=True,
                                      check=True).stdout.strip()

            git("init", "-q")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                "commit", "-q", "--allow-empty", "-m", "base")
            tracked = root / "tracked"
            tracked.write_text("candidate")
            git("add", "tracked")
            signed = {"sourceSha": git("rev-parse", "HEAD"), "sourceTreeSha": git("write-tree")}
            verify_source(root, signed, "candidate")
            with self.assertRaisesRegex(ValueError, "release checkout is dirty"):
                verify_source(root, signed, "release")
            tracked.write_text("changed after signing")
            with self.assertRaisesRegex(ValueError, "could not verify signed Git identity"):
                verify_source(root, signed, "candidate")
            git("restore", "tracked")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                "commit", "-q", "-m", "candidate")
            verify_source(root, signed, "release")

    @unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH is needed")
    def test_scheduled_manifest_requires_the_current_namespace(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bundle = root / "bundle"
            bundle.mkdir()
            raw = b'{"schemaVersion":1}'
            manifest = bundle / "manifest.json"
            manifest.write_bytes(raw)
            keys = []
            for role in ROLES:
                key = root / role
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
                keys.append(" ".join([role, *key.with_suffix(".pub").read_text().split()[:2]]))
                subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(key), "-n", NAMESPACE, str(manifest)],
                               capture_output=True, check=True)
                manifest.with_suffix(".json.sig").rename(bundle / f"{role}.sig")
            trusted = root / "trusted-signers"
            trusted.write_text("\n".join(keys) + "\n")
            verify_signatures(bundle, raw, trusted, NAMESPACE)
            with self.assertRaisesRegex(ValueError, "invalid release manifest signature"):
                verify_signatures(bundle, raw, trusted)
