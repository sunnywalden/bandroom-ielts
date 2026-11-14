#!/usr/bin/env python3
"""QA-scoped G5 evidence exporter for the Bandroom G3 fix (D-6 / BL4).

DERIVED, VERSIONED ARTIFACT. ``run-side/export_g5_evidence.py``
(sha256 dc2b308f..., see STREAM2_REPORT.md) is frozen and is NOT edited. This
QA exporter:

* runs only with ``--qa-scoped`` and writes protocol
  ``bandroom-d2-cloud-recovery-v1-qa-diagnostic`` with ``qaScoped: true`` and
  ``identityScope: "qa-diagnostic"``;
* keeps formal candidate identity fields null;
* binds QA-named artifacts (qa-runtime-bundle.zip, qa-model-weights.bin,
  qa-analysis-config.json) to their own digests instead of pretending to be
  G5 file objects;
* performs the owner-approved deterministic receipt backfill
  id="rcpt-"+payloadSha256[:32], feedbackId="fb-"+payloadSha256[:32] and
  records that derivation instead of claiming a fresh server receipt;
* bypasses the formal build() early blocks for QA only: the >=3 wake /
  >=86400 s observation, the 12-field feedback receipt, and the projected
  officialRecordRef. It never fabricates those values; it emits a waiver or a
  null disclosure;
* has a separate ``check_qa()``. The frozen ``check()`` is not branched.

This tool never contacts a network or a cloud service and never signs. The
package is a QA-scoped G3 evidence subset, not a formal G5 pass.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from shutil import copyfile

NAMESPACE = "bandroom-d2-cloud-recovery-v1-qa-diagnostic"
FORMAL_NAMESPACE = "bandroom-d2-cloud-recovery-v1"
IDENTITY_SCOPE = "qa-diagnostic"
ROUTE = "A"
INPUT_BYTES = 441_322

# G3 owns two roles. Formal G5 needs four; that is out of QA scope.
QA_ROLES = ("work-auditor", "site-auditor")

QA_FILES = (
    "qa-runtime-bundle.zip",
    "qa-model-weights.bin",
    "qa-analysis-config.json",
    "offline.json",
    "official-run-history.json",
    "site-event-export.json",
    "qa-feedback-receipt.json",
)

QA_STATIC_FILES = ("qa-runtime-bundle.zip", "qa-model-weights.bin", "qa-analysis-config.json")

QA_SUPPLEMENT_FILES = (
    "stage-a.json", "stage-b.json", "stage-c.json",
    *(f"checkpoint-{index}.bin" for index in range(1, 7)),
    "checkpoint-0.json", "checkpoint-7.json", "cold.bin", "resumed.bin",
    "qa-runtime-provenance.json", "platform-probe.json", "runtime-profile.json",
    "cloud-v4-v5-owner-decision.json", "v4-cloud-run.json", "v4-work-readback.json",
    "v5-d-artifact-readback.json", "cloud-preflight-readback.json", "cloud-qa-deployment.json",
    "cloud-receipt-migration-dry-run.json", "cloud-receipt-migration-apply.json",
    "cloud-receipt-replay.json", "cloud-receipt-input-bytes-readback.json", "cloud-m4-fixture-readback.json",
    "cloud-m4-instruction-deployment.json", "cloud-m4-schedule.json",
    "cloud-m4-schedule-evidence-clarification.json", "cloud-m4-work-history-readback.json",
    "cloud-m4-run-readback.json", "cloud-chrome-different-markers.json",
    "cloud-chrome-slow-loadedmetadata.json", "cloud-m9-closure.json",
    *(f"cloud-m4-{hour:02d}00-{kind}.json" for hour in range(6, 18)
      for kind in ("native-report", "work-summary")),
    "fairness.json",
)
D_ARTIFACT_FILES = (
    *(f"acoustic-{index:02}.bin" for index in range(10)),
    "offline-checkpoint.bin", "plan.json",
)
D_MISSING = "missing/G1-G2-dependent"
UNSIGNED = "unsigned-keys-absent"

# Formal candidate identity fields must stay null in a QA bundle.
FORMAL_NULL_FIELDS = (
    "sourceSha",
    "sourceTreeSha",
    "buildSha256",
    "runtimeBundleSha256",
    "modelWeightsSha256",
    "configSha256",
)

# A QA bundle must not carry formal-only artifact names.
FORMAL_ONLY_FILES = frozenset({
    "runtime-bundle.zip", "model-weights.bin", "analysis-config.json",
    "gates.json", "zero-cost.json",
})

WORK_EVENTS = (
    ("A", ("claimed", "retry_wait")),
    ("B", ("claimed", "recording_verified", "checkpoint_saved", "interrupted")),
    ("C", ("claimed", "checkpoint_restored", "suffix_completed", "feedback_committed", "receipt_readback")),
)
CLOUD_EVENT_TYPES = frozenset(event_type for _, types in WORK_EVENTS for event_type in types)
DIGEST = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
SHA40 = re.compile(r"^[0-9a-f]{40}$")


class Blocked(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Blocked(message)


def read_json(path: Path) -> dict:
    require(path.is_file(), f"missing input {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise Blocked(f"{path} is not valid JSON: {error}") from error
    require(isinstance(value, dict), f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def sha_file(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def first_text(*values) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def first_int(*values) -> int | None:
    for value in values:
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def get_any(obj, *keys, default=None):
    if not isinstance(obj, dict):
        return default
    for key in keys:
        if key in obj and obj[key] is not None:
            return obj[key]
    return default


def derived_receipt_identity(payload_sha256: str) -> tuple[str, str]:
    require(isinstance(payload_sha256, str) and bool(DIGEST.match(payload_sha256)),
            "receipt backfill needs a 64-hex payloadSha256")
    return f"rcpt-{payload_sha256[:32]}", f"fb-{payload_sha256[:32]}"


def derive_timestamps(row: dict) -> dict:
    """Derive startedAt/endedAt only from a named observed field.

    An underivable timestamp stays null with a disclosure. Nothing is invented.
    """
    started_at = first_text(row.get("startedAt"), row.get("started_at"))
    started_source = first_text(row.get("startedAtSource"), "platform-startedAt") if started_at else "unavailable"
    if not started_at:
        for key in ("firstSiteWakeAt", "scheduledSlotUtc", "availableAt"):
            candidate = first_text(row.get(key))
            if candidate:
                started_at, started_source = candidate, f"derived-from-{key}"
                break
    ended_at = first_text(row.get("endedAt"), row.get("ended_at"))
    ended_source = first_text(row.get("endedAtSource"), "platform-endedAt") if ended_at else "unavailable"
    if not ended_at:
        for key in ("executionEndObservedAt", "availableAt"):
            candidate = first_text(row.get(key))
            if candidate:
                ended_at, ended_source = candidate, f"derived-from-{key}"
                break
    return {
        "startedAt": started_at,
        "endedAt": ended_at,
        "startedAtSource": started_source,
        "endedAtSource": ended_source,
    }


def run_report(run: Path, step: str) -> dict:
    return read_json(run / "runs" / f"{step.lower()}.json")


# --------------------------------------------------------------------------
# QA composition
# --------------------------------------------------------------------------

def compose_history_qa(run: Path, site_raw: list[dict]) -> dict:
    """QA history: A/B/C(+D), officialRefs required, wakes waived or real."""
    history = read_json(run / "official" / "run-history.json")
    automation = first_text(history.get("automationId"), history.get("automation_id"))
    require(bool(automation), "history lacks automationId")

    reports = {step: run_report(run, step) for step in ("A", "B", "C")}
    stage_runs: dict[str, str] = {}
    records = []
    for step, report in reports.items():
        official_run_id = first_text(report.get("officialRunId"), report.get("official_run_id"))
        require(bool(official_run_id) and bool(UUID.match(official_run_id)),
                f"run {step} carries no lowercase-UUID officialRunId")
        stage_runs[step] = official_run_id
        timestamps = derive_timestamps(report)
        record = {
            "stage": step,
            "step": step,
            "officialRunId": official_run_id,
            "fence": first_int(report.get("fence")),
            "automationId": first_text(report.get("automationId"), automation),
            "taskId": first_text(report.get("taskId"), history.get("taskId"), automation),
            # Projection is labelled; it is never presented as a separate token.
            "officialRecordRef": first_text(report.get("officialRecordRef"), official_run_id),
            "officialRecordRefSource": "projected-from-officialRunId",
            "source": first_text(report.get("source")),
            "isolated": report.get("isolated"),
            "clientExecution": report.get("clientExecution"),
            "approvalPrompts": report.get("approvalPrompts"),
            "quotaObservation": report.get("quotaObservation"),
            "qaUnobserved": sorted(
                key for key in ("source", "isolated", "clientExecution", "approvalPrompts", "quotaObservation")
                if report.get(key) is None
            ),
            **timestamps,
        }
        records.append(record)

    # Run D is optional in QA. If it exists it must be distinct and read-only.
    cold_report = None
    if (run / "runs" / "d.json").is_file():
        cold_report = read_json(run / "runs" / "d.json")
    cold_history = history.get("coldRun")
    cold_run_id = first_text(
        get_any(cold_report or {}, "officialRunId", "official_run_id"),
        get_any(cold_history or {}, "officialRunId", "official_run_id"),
    )
    if cold_run_id:
        require(bool(UUID.match(cold_run_id)), "run D officialRunId is not a lowercase UUID")
        require(cold_run_id not in stage_runs.values(), "run D officialRunId must be distinct from A/B/C")
        timestamps = derive_timestamps(cold_report or cold_history or {})
        records.append({
            "stage": "D",
            "step": "D",
            "officialRunId": cold_run_id,
            "fence": None,
            "automationId": automation,
            "taskId": first_text(history.get("taskId"), automation),
            "officialRecordRef": first_text(
                get_any(cold_report or {}, "officialRecordRef"),
                get_any(cold_history or {}, "officialRecordRef"),
                cold_run_id,
            ),
            "officialRecordRefSource": "projected-from-officialRunId",
            "source": first_text(get_any(cold_report or {}, "source"),
                                 get_any(cold_history or {}, "source")),
            "isolated": get_any(cold_report or {}, "isolated", default=get_any(cold_history or {}, "isolated")),
            "clientExecution": get_any(cold_report or {}, "clientExecution"),
            "approvalPrompts": get_any(cold_report or {}, "approvalPrompts"),
            "quotaObservation": get_any(cold_report or {}, "quotaObservation"),
            "readOnly": True,
            **timestamps,
        })

    official_refs: dict[str, dict] = {}
    source_refs = history.get("officialRefs") if isinstance(history.get("officialRefs"), dict) else {}
    for stage, official_run_id in stage_runs.items():
        entry = source_refs.get(stage) if isinstance(source_refs.get(stage), dict) else {}
        rich = {key: entry[key] for key in ("userTurnId", "assistantMessageId", "turnKey")
                if isinstance(entry.get(key), str) and entry[key].strip()}
        official_refs[stage] = {"officialRunId": official_run_id, **rich}
    history["officialRefs"] = official_refs
    history["officialRefsSource"] = "projected-from-officialRunId"
    history["runs"] = records

    # Empty-queue wakes: carry only observed wake rows. Never synthesize.
    mapping = {}
    wake_map_path = run / "official" / "wake-runs.json"
    if wake_map_path.is_file():
        for row in read_json(wake_map_path).get("wakes", []):
            if isinstance(row, dict) and row.get("at"):
                mapping[row["at"]] = row
    wakes = []
    for row in site_raw:
        if not isinstance(row, dict) or row.get("kind") != "wake":
            continue
        record = mapping.get(row.get("at"), {})
        wake = {
            "officialRunId": first_text(record.get("officialRunId")),
            "officialRecordRef": first_text(record.get("officialRecordRef")),
            "automationId": automation,
            "source": first_text(record.get("source"), row.get("source")),
            "clientExecution": record.get("clientExecution"),
            "approvalPrompts": record.get("approvalPrompts"),
            "discoveredCount": record.get("discoveredCount"),
            "createdCount": record.get("createdCount"),
            "startedAt": first_text(record.get("startedAt"), row.get("utc"), row.get("at")),
            "utc": first_text(row.get("utc"), row.get("at")),
            "pendingCount": row.get("pendingCount"),
            "pendingAcoustics": row.get("pendingAcoustics"),
            "subscriptionActive": row.get("subscriptionActive"),
            "emptyQueueAccepted": row.get("emptyQueueAccepted"),
        }
        observed = {key: value for key, value in wake.items() if value is not None}
        observed["qaUnobserved"] = sorted(key for key, value in wake.items()
                                          if value is None and key not in ("officialRunId",
                                                                           "officialRecordRef"))
        wakes.append(observed)
    history["emptyQueueWakes"] = wakes

    stamps = []
    for wake in wakes:
        stamp = first_text(wake.get("startedAt"), wake.get("utc"))
        if stamp:
            try:
                stamp_dt = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                if stamp_dt.tzinfo is None:
                    stamp_dt = stamp_dt.replace(tzinfo=timezone.utc)
                stamps.append(stamp_dt)
            except ValueError:
                pass
    span = (max(stamps) - min(stamps)).total_seconds() if len(stamps) >= 2 else 0.0
    waiver = history.get("observationWaiver", history.get("observation_waiver"))
    formal_waived = history.get("formalG5ObservationWaived")
    waiver_recorded = False
    if isinstance(waiver, dict):
        waiver_recorded = waiver.get("waived") is True
    elif isinstance(waiver, str):
        waiver_recorded = bool(waiver.strip())
    if len(wakes) >= 3 and span >= 86_400:
        history["emptyQueueWakesWaived"] = False
    elif waiver_recorded and formal_waived is False:
        history["emptyQueueWakesWaived"] = True
        history["emptyQueueWakesWaiverLabel"] = (
            "WAIVED (explicit owner observation waiver): "
            f"{waiver if isinstance(waiver, str) else waiver.get('reason') or waiver.get('scope') or 'owner waiver'}; "
            "formalG5ObservationWaived=false"
        )
    else:
        # No waiver: leave the frozen failure in force. Do not invent one.
        history["emptyQueueWakesWaived"] = False
        history["emptyQueueWakesWaiverUnavailable"] = (
            "no explicit observationWaiver with formalG5ObservationWaived=false"
        )
    history["observationWaiver"] = waiver
    history["formalG5ObservationWaived"] = formal_waived if formal_waived is not None else None
    history["qaScoped"] = True
    history["identityScope"] = IDENTITY_SCOPE
    return history


def _receipt_source(run: Path, report: dict) -> dict:
    for key in ("feedbackReceipt", "completionReceipt"):
        if isinstance(report.get(key), dict):
            return dict(report[key])
    for path in (run / "official" / "completion-receipt.json", run / "offline.json"):
        if path.is_file():
            document = read_json(path)
            for key in ("feedbackReceipt", "completionReceipt"):
                if isinstance(document.get(key), dict):
                    return dict(document[key])
    raise Blocked("no feedback/completion receipt supplied; refusing to invent one")


def compose_feedback_receipt(report_c: dict, report_identity: dict, official_record_ref: str) -> dict:
    receipt = _receipt_source(report_identity["_run"], report_c)
    payload_sha = first_text(receipt.get("payloadSha256"), receipt.get("payload_sha256"))
    existing_id = first_text(receipt.get("id"))
    existing_feedback = first_text(receipt.get("feedbackId"), receipt.get("feedback_id"))
    if payload_sha:
        expected_id, expected_feedback = derived_receipt_identity(payload_sha)
        require(existing_id in (None, expected_id),
                "existing receipt id does not match the deterministic payloadSha256 derivation")
        require(existing_feedback in (None, expected_feedback),
                "existing feedbackId does not match the deterministic payloadSha256 derivation")
        receipt["id"] = expected_id
        receipt["feedbackId"] = expected_feedback
        receipt["receiptIdentitySource"] = (
            "existing-bound-to-payloadSha256" if existing_id and existing_feedback
            else "derived-from-payloadSha256"
        )
        receipt["receiptIdentityRule"] = "id='rcpt-'+payloadSha256[:32]; feedbackId='fb-'+payloadSha256[:32]"
    else:
        require(bool(existing_id) and bool(existing_feedback),
                "receipt has neither a payloadSha256 nor an existing id/feedbackId")
        receipt["receiptIdentitySource"] = "existing"
    input_bytes = first_int(receipt.get("inputBytes"), receipt.get("input_bytes"))
    require(input_bytes is not None, "receipt must carry inputBytes; it is never invented")
    receipt["inputBytes"] = input_bytes
    receipt["officialRecordRef"] = first_text(
        receipt.get("officialRecordRef"), official_record_ref)
    require(bool(receipt["officialRecordRef"]), "receipt lacks officialRecordRef")
    receipt.setdefault("fence", report_c.get("fence"))
    receipt.setdefault("outputSha256", report_c.get("outputSha256"))
    receipt["identityScope"] = IDENTITY_SCOPE
    receipt["recordingIdScope"] = "not-a-recording-sha"
    if not first_text(receipt.get("recordingId")):
        receipt["recordingId"] = None
        receipt["recordingIdSource"] = "unavailable"
    if not first_text(receipt.get("attemptId")):
        receipt["attemptId"] = None
        receipt["attemptIdSynthetic"] = "not-available-in-qa"
    receipt["analysisVersionScope"] = IDENTITY_SCOPE
    receipt["backfillDisclosure"] = (
        "read-time deterministic backfill; no completed run was re-executed (BL1)"
    )
    return receipt


def compose_offline_qa(run: Path, identity: dict, history: dict, site_raw: list[dict]) -> dict:
    reports = {step: run_report(run, step) for step in ("A", "B", "C")}
    stage_runs = {step: first_text(report.get("officialRunId"), report.get("official_run_id"))
                  for step, report in reports.items()}
    for step, run_id in stage_runs.items():
        require(bool(run_id) and bool(UUID.match(run_id)), f"run {step} officialRunId is not a UUID")
    history_by_stage = {row.get("stage"): row for row in history.get("runs", []) if isinstance(row, dict)}
    runs = []
    for step in ("A", "B", "C"):
        report = reports[step]
        record = history_by_stage.get(step, {})
        runs.append({
            "step": step,
            "stage": step,
            "officialRunId": stage_runs[step],
            "officialRecordRef": record.get("officialRecordRef"),
            "officialRecordRefSource": record.get("officialRecordRefSource"),
            "fence": first_int(report.get("fence")),
            "automationId": first_text(report.get("automationId"), history.get("automationId")),
            "taskId": record.get("taskId"),
            "startedAt": record.get("startedAt"),
            "endedAt": record.get("endedAt"),
            "startedAtSource": record.get("startedAtSource"),
            "endedAtSource": record.get("endedAtSource"),
            "source": record.get("source"),
            "isolated": record.get("isolated"),
            "clientExecution": record.get("clientExecution"),
            "approvalPrompts": record.get("approvalPrompts"),
            "jobId": first_text(report.get("jobId"), history.get("jobId")),
            "recordingSha256": first_text(report.get("recordingSha256"), history.get("recordingSha256")),
            "inputBytes": first_int(report.get("inputBytes"), history.get("inputBytes")),
        })
    receipt = compose_feedback_receipt(reports["C"], {**reports["C"], "_run": run}, stage_runs["C"])
    cold_run_id = next((row.get("officialRunId") for row in history.get("runs", [])
                        if isinstance(row, dict) and row.get("stage") == "D"), None)
    fairness = None
    fairness_path = run / "official" / "fairness.json"
    if fairness_path.is_file():
        fairness = read_json(fairness_path)
    else:
        fairness = {
            "fairnessScope": "not-applicable-qa",
            "fairnessDisclosure": "no real multi-task fairness scenario exists in the QA environment (MJ4)",
        }
    offline = {
        "scope": IDENTITY_SCOPE,
        "qaScoped": True,
        "identityScope": IDENTITY_SCOPE,
        "isolated": history.get("isolated") if history.get("isolated") is True else None,
        "isolatedSource": "history.isolated" if history.get("isolated") is True else "unavailable",
        "automationId": history.get("automationId"),
        "jobId": first_text(history.get("jobId"), receipt.get("jobId")),
        "taskId": first_text(history.get("taskId"), history.get("automationId")),
        "recipeSha256": first_text(history.get("recipeSha256"), receipt.get("recipeSha256")),
        "analysisVersion": first_text(identity.get("analysisVersion"), IDENTITY_SCOPE),
        "environmentId": first_text(identity.get("environmentId"), IDENTITY_SCOPE),
        "recordingSha256": first_text(history.get("recordingSha256"), receipt.get("recordingSha256")),
        "inputBytes": first_int(receipt.get("inputBytes"), history.get("inputBytes")),
        "runs": runs,
        "coldRunId": cold_run_id,
        "feedbackReceipt": receipt,
        "jobState": reports["C"].get("jobState"),
        "duplicateFeedbackCount": reports["C"].get("duplicateFeedbackCount"),
        "feedbackVisible": reports["C"].get("feedbackVisible"),
        "fairness": fairness,
        "completionReceipt": receipt,
        # Formal candidate identity stays null in a QA bundle.
        **{key: None for key in FORMAL_NULL_FIELDS},
    }
    return offline


def compose_site_qa(site_raw: list[dict], offline: dict, site_document: dict) -> dict:
    receipt = offline["feedbackReceipt"]
    client_operations = site_document.get("clientOperationsDuringClosure")
    cloud = [dict(row) for row in site_raw
             if isinstance(row, dict) and row.get("type") in CLOUD_EVENT_TYPES]
    require(all(row.get("source") == "cloud" for row in cloud),
            "a QA cloud event is not source=cloud")
    by_run = {row["officialRunId"]: row["step"] for row in offline["runs"]}
    for step, expected in WORK_EVENTS:
        observed = [row.get("type") for row in cloud
                    if by_run.get(row.get("officialRunId")) == step]
        require(tuple(observed) == expected,
                f"QA site event order for {step} is {observed}; expected {list(expected)}")
    for row in cloud:
        row["at"] = first_text(row.get("at"), row.get("utc"))
        if row.get("type") == "feedback_committed":
            row["receiptId"] = first_text(row.get("receiptId"), receipt.get("id"))
            row["receiptIdSource"] = "derived-from-payloadSha256"
        elif row.get("type") == "receipt_readback":
            row["receiptId"] = first_text(row.get("receiptId"), receipt.get("id"))
            row["feedbackId"] = first_text(row.get("feedbackId"), receipt.get("feedbackId"))
            row["outputSha256"] = first_text(row.get("outputSha256"), receipt.get("outputSha256"))
            row["receiptIdSource"] = "derived-from-payloadSha256"
        else:
            row.setdefault("receiptId", None)
    return {
        "qaScoped": True,
        "identityScope": IDENTITY_SCOPE,
        "events": cloud,
        "clientOperationsDuringClosure": client_operations if isinstance(client_operations, list) else None,
        "clientOperationsScope": (
            first_text(site_document.get("clientOperationsScope"), "observed")
            if isinstance(client_operations, list) else "unavailable"
        ),
        "feedbackReceipt": receipt,
    }


def compose_browser_qa(browser: dict) -> dict:
    core_cases = ("playback", "pause", "refresh", "reopen", "slow-loadedmetadata", "repeat-marker")
    supplied = browser.get("cases") if isinstance(browser.get("cases"), dict) else {}
    cases = {name: supplied[name] for name in core_cases if name in supplied}
    passed = sum(1 for row in cases.values()
                 if isinstance(row, dict) and row.get("status") == "passed")
    observations = (
        "status", "subject", "observedAt", "method", "navigator", "audioOutput",
        "humanEvidenceWaived", "humanEvidenceWaiverRef", "humanEvidenceCount", "humanEvidence",
        "reviews", "timingToleranceMs", "maximumMediaErrorMs", "historicalTrace",
        "crossDeploymentDisclosure", "releaseRetest53", "learnerBaselineScope",
    )
    slow_metadata = cases.get("slow-loadedmetadata")
    slow_metadata_method = (
        slow_metadata.get("method")
        if isinstance(slow_metadata, dict) and slow_metadata.get("status") == "passed"
        else None
    )
    return {
        "qaScoped": True,
        "identityScope": IDENTITY_SCOPE,
        "caseCounts": {"scope": "contract-5.2", "passed": passed, "total": len(core_cases)},
        "cases": cases,
        "releaseRetest53": {"status": "deferred/N-A"},
        "learnerBaselineScope": "not-applicable-qa",
        "learnerBaselineBefore": None,
        "learnerBaselineAfter": None,
        "rollbackVerified": None,
        "slowLoadedMetadataExecution": slow_metadata_method,
        "repeatMarkerDeviation": "consecutive clicks must use different markers; same-marker runs are a disclosed deviation",
        **{key: browser[key] for key in observations if key in browser},
    }


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def build_qa(run: Path, out: Path, static: Path, *, unsigned_keys_absent: bool = False) -> None:
    identity = read_json(run / "identity.json") if (run / "identity.json").is_file() else {}
    # Null-safe lookups; the frozen build() indexed identity[key] directly.
    require(first_text(identity.get("route"), ROUTE) == ROUTE, "identity route must be A")

    site_source = run / "site" / "site-events.json"
    site_document = read_json(site_source)
    site_raw = site_document.get("events", [])
    require(isinstance(site_raw, list), "site-events.json events must be a list")

    history = compose_history_qa(run, site_raw)
    offline = compose_offline_qa(run, identity, history, site_raw)
    site = compose_site_qa(site_raw, offline, site_document)

    out.mkdir(parents=True, exist_ok=False)
    write_json(out / "offline.json", offline)
    write_json(out / "official-run-history.json", history)
    write_json(out / "site-event-export.json", site)
    write_json(out / "qa-feedback-receipt.json", offline["feedbackReceipt"])

    for name in QA_STATIC_FILES:
        source = static / name
        require(source.is_file(), f"QA static artifact {name} is not supplied")
        copyfile(source, out / name)

    browser_source = run / "browser" / "browser-acceptance.json"
    written = list(QA_FILES)
    if browser_source.is_file():
        write_json(out / "qa-browser-acceptance.json", compose_browser_qa(read_json(browser_source)))
        written.append("qa-browser-acceptance.json")
    for name in QA_SUPPLEMENT_FILES:
        source = run / "evidence" / name
        if source.is_file():
            copyfile(source, out / name)
            written.append(name)

    files = {name: sha_file(out / name) for name in written}
    manifest = {
        "schemaVersion": 1,
        "protocol": NAMESPACE,
        "route": ROUTE,
        "qaScoped": True,
        "identityScope": IDENTITY_SCOPE,
        "analysisVersion": first_text(identity.get("analysisVersion"), IDENTITY_SCOPE),
        "environmentId": first_text(identity.get("environmentId"), IDENTITY_SCOPE),
        "qaRuntimeBundleSha256": files["qa-runtime-bundle.zip"],
        "qaModelWeightsSha256": files["qa-model-weights.bin"],
        "qaConfigSha256": files["qa-analysis-config.json"],
        "files": files,
        # Never let a QA digest occupy a formal candidate field.
        **{key: None for key in FORMAL_NULL_FIELDS},
    }
    if "v5-d-artifact-readback.json" in files:
        v5 = read_json(out / "v5-d-artifact-readback.json")
        decision = read_json(out / "cloud-v4-v5-owner-decision.json")
        require(decision.get("ownerDecision", {}).get("status") == "confirmed",
                "V5 disposition requires a confirmed owner decision")
        disposition = decision.get("v5", {})
        names = [row.get("name") for row in v5.get("requiredArtifacts", []) if row.get("status") == "missing"]
        require(
            v5.get("disposition") == disposition.get("disposition") == D_MISSING
            and v5.get("verifiedArtifactCount") == disposition.get("verifiedArtifacts") == 0
            and v5.get("requiredArtifactCount") == disposition.get("expectedArtifacts") == len(D_ARTIFACT_FILES)
            and v5.get("diagnosticOutputSubstituted") is disposition.get("diagnosticSubstitution") is False
            and disposition.get("v26PrefixRemapped") is False
            and sorted(names) == sorted(D_ARTIFACT_FILES),
            "V5 readback and owner decision must bind the same 12 missing artifacts",
        )
        manifest["runDArtifacts"] = {**disposition, "missingFiles": list(D_ARTIFACT_FILES)}
    if unsigned_keys_absent:
        manifest["signatureStatus"] = UNSIGNED
        manifest["signatureRoles"] = dict.fromkeys(QA_ROLES, "absent")
    write_json(out / "manifest.json", manifest)
    print(f"wrote QA-scoped {out} with {len(written)} files (protocol {NAMESPACE})")
    print("QA-scoped G3 subset: not a formal G5 pass; two-role signing is separate")


# --------------------------------------------------------------------------
# QA check (separate from the frozen formal check())
# --------------------------------------------------------------------------

class QaChecks:
    def __init__(self, title: str) -> None:
        self.title = title
        self.rows: list[tuple[str, str, str]] = []

    def add(self, ok: bool, name: str, detail="") -> None:
        text = "" if detail is None or detail == "" else str(detail)
        self.rows.append(("PASS" if ok else "FAIL", name, text))

    def waive(self, name: str, detail="") -> None:
        text = "" if detail is None or detail == "" else str(detail)
        self.rows.append(("WAIVED", name, text))

    def report(self) -> int:
        print(f"== {self.title} ==")
        failed = waived = 0
        for status, name, detail in self.rows:
            print(f"{status}  {name}" + (f"  [{detail}]" if detail else ""))
            failed += status == "FAIL"
            waived += status == "WAIVED"
        passed = len(self.rows) - failed - waived
        suffix = f", {waived} waived (explicit, not counted as passed)" if waived else ""
        print(f"\n{passed}/{len(self.rows)} checks passed{suffix}")
        return 1 if failed else 0


def check_qa(evidence: Path, require_signatures: bool = True) -> int:
    """Validate a QA-scoped bundle only. Never accepts a formal manifest."""
    c = QaChecks("QA-scoped G3 evidence bundle")

    manifest_path = evidence / "manifest.json"
    if not manifest_path.is_file():
        print("FAIL  manifest.json missing")
        return 1
    try:
        manifest = read_json(manifest_path)
    except Blocked as error:
        print(f"FAIL  {error}")
        return 1

    c.add(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1,
          "schemaVersion must be 1", manifest.get("schemaVersion"))
    c.add(manifest.get("protocol") == NAMESPACE,
          f"protocol must be QA namespace {NAMESPACE}", manifest.get("protocol"))
    c.add(manifest.get("qaScoped") is True, "qaScoped must be true", manifest.get("qaScoped"))
    c.add(manifest.get("identityScope") == IDENTITY_SCOPE,
          f"identityScope must be {IDENTITY_SCOPE}", manifest.get("identityScope"))
    c.add(manifest.get("route") == "A", "route must be A", manifest.get("route"))
    c.add(bool(first_text(manifest.get("analysisVersion"))), "analysisVersion label present")
    c.add(bool(first_text(manifest.get("environmentId"))), "environmentId label present")
    for key in FORMAL_NULL_FIELDS:
        c.add(manifest.get(key) is None, f"formal candidate field {key} must stay null",
              manifest.get(key))

    hashes = manifest.get("files")
    c.add(isinstance(hashes, dict), "manifest.files object present", type(hashes).__name__)
    if not isinstance(hashes, dict):
        return c.report()
    c.add(all(DIGEST.match(value or "") is not None for value in hashes.values()),
          "every manifest digest is 64 lowercase hex")
    c.add(set(QA_FILES) <= set(hashes), "manifest lists every QA G3-owned file",
          sorted(set(QA_FILES) - set(hashes)))
    c.add(not (FORMAL_ONLY_FILES & set(hashes)),
          "QA bundle must not carry formal-only artifact names",
          sorted(FORMAL_ONLY_FILES & set(hashes)))
    if "v5-d-artifact-readback.json" in hashes or "runDArtifacts" in manifest:
        missing = {
            "disposition": D_MISSING, "verifiedArtifacts": 0,
            "expectedArtifacts": len(D_ARTIFACT_FILES), "missingFiles": list(D_ARTIFACT_FILES),
            "diagnosticSubstitution": False, "v26PrefixRemapped": False,
        }
        c.add(manifest.get("runDArtifacts") == missing, "Run D manifest marks all 12 originals missing")
        excluded = {*D_ARTIFACT_FILES, "offline-output.json", "offline-cold-output.json"}
        found = {name for name in excluded if (evidence / name).exists()} | (excluded & set(hashes))
        c.add(not found, "missing Run D files and diagnostic substitutes are absent", sorted(found))
        c.add({"v5-d-artifact-readback.json", "cloud-v4-v5-owner-decision.json"} <= set(hashes),
              "Run D manifest binds V5 readback and owner decision")
    for name, expected in sorted(hashes.items()):
        path = evidence / name
        if not path.is_file():
            c.add(False, f"listed file present: {name}")
        else:
            c.add(sha_file(path) == expected, f"digest matches: {name}")
    c.add(manifest.get("qaRuntimeBundleSha256") == hashes.get("qa-runtime-bundle.zip"),
          "qa-runtime-bundle.zip binds its own digest")
    c.add(manifest.get("qaModelWeightsSha256") == hashes.get("qa-model-weights.bin"),
          "qa-model-weights.bin binds its own digest")
    c.add(manifest.get("qaConfigSha256") == hashes.get("qa-analysis-config.json"),
          "qa-analysis-config.json binds its own digest")

    offline_path = evidence / "offline.json"
    offline = read_json(offline_path) if offline_path.is_file() else None
    if not isinstance(offline, dict):
        c.add(False, "offline.json object present")
        return c.report()
    c.add(offline.get("isolated") is True, "offline.isolated must be true", offline.get("isolated"))
    c.add(offline.get("identityScope") == IDENTITY_SCOPE, "offline.identityScope is qa-diagnostic")
    for key in FORMAL_NULL_FIELDS:
        c.add(offline.get(key) is None, f"offline formal candidate field {key} must stay null",
              offline.get(key))
    runs = offline.get("runs")
    c.add(isinstance(runs, list) and [row.get("step") for row in runs if isinstance(row, dict)] == ["A", "B", "C"],
          "offline.runs must be exactly A/B/C (QA G3 subset)",
          [row.get("step") for row in runs] if isinstance(runs, list) else type(runs).__name__)
    if isinstance(runs, list) and len(runs) == 3:
        run_ids = [row.get("officialRunId") for row in runs]
        fences = [row.get("fence") for row in runs]
        c.add(all(isinstance(run_id, str) and UUID.match(run_id or "") for run_id in run_ids),
              "offline run officialRunIds are lowercase UUIDs", run_ids)
        c.add(len(set(run_ids)) == 3, "offline run officialRunIds are distinct")
        c.add(all(isinstance(fence, int) and not isinstance(fence, bool) and fence >= 1
                  for fence in fences), "offline fences are positive integers", fences)
        c.add(fences == sorted(fences), "offline fences are strictly increasing", fences)
        automation = offline.get("automationId")
        c.add(all(row.get("automationId") == automation for row in runs),
              "offline run automationId matches offline.automationId", automation)
    c.add(isinstance(offline.get("inputBytes"), int) and offline["inputBytes"] == INPUT_BYTES,
          f"offline.inputBytes must be {INPUT_BYTES}", offline.get("inputBytes"))

    receipt = offline.get("feedbackReceipt")
    receipt_file = evidence / "qa-feedback-receipt.json"
    if not isinstance(receipt, dict):
        c.add(False, "offline.feedbackReceipt object present")
    else:
        c.add(receipt_file.is_file() and read_json(receipt_file) == receipt,
              "qa-feedback-receipt.json equals offline.feedbackReceipt")
        for key in ("id", "feedbackId", "officialRecordRef"):
            c.add(bool(first_text(receipt.get(key))), f"feedbackReceipt.{key} present", receipt.get(key))
        c.add(receipt.get("inputBytes") == INPUT_BYTES,
              f"feedbackReceipt.inputBytes = {INPUT_BYTES}", receipt.get("inputBytes"))
        payload_sha = first_text(receipt.get("payloadSha256"))
        if payload_sha:
            expected_id, expected_feedback = derived_receipt_identity(payload_sha)
            c.add(receipt.get("id") == expected_id, "receipt id is deterministic from payloadSha256",
                  receipt.get("id"))
            c.add(receipt.get("feedbackId") == expected_feedback,
                  "feedbackId is deterministic from payloadSha256", receipt.get("feedbackId"))
        else:
            c.add(receipt.get("receiptIdentitySource") == "existing",
                  "receipt identity source disclosed when no payloadSha256 is available")

    history_path = evidence / "official-run-history.json"
    history = read_json(history_path) if history_path.is_file() else None
    if not isinstance(history, dict):
        c.add(False, "official-run-history.json object present")
    else:
        c.add(bool(first_text(history.get("automationId"))), "history automationId present")
        records = history.get("runs")
        c.add(isinstance(records, list) and len(records) >= 3,
              "history has A/B/C records", len(records) if isinstance(records, list) else None)
        if isinstance(records, list):
            c.add(all(isinstance(row, dict) and UUID.match(row.get("officialRunId") or "")
                      for row in records), "history run officialRunIds are UUIDs")
            c.add(all(row.get("endedAtSource") is not None for row in records if isinstance(row, dict)),
                  "history run endedAt carries an endedAtSource label")
            c.add(all(row.get("officialRecordRef") for row in records if isinstance(row, dict)),
                  "history runs carry a projected officialRecordRef")
        refs = history.get("officialRefs")
        c.add(isinstance(refs, dict), "history.officialRefs object present", type(refs).__name__)
        if isinstance(refs, dict):
            for stage in ("A", "B", "C"):
                ref = refs.get(stage)
                c.add(isinstance(ref, dict), f"officialRefs.{stage} present")
                if isinstance(ref, dict):
                    c.add(isinstance(ref.get("officialRunId"), str)
                          and UUID.match(ref["officialRunId"] or "") is not None,
                          f"officialRefs.{stage}.officialRunId is a lowercase UUID",
                          ref.get("officialRunId"))
        wakes = history.get("emptyQueueWakes")
        c.add(isinstance(wakes, list), "history.emptyQueueWakes list present",
              type(wakes).__name__)
        if isinstance(wakes, list):
            stamps = []
            for wake in wakes:
                stamp = first_text(get_any(wake, "startedAt", "utc", "at"))
                if stamp:
                    try:
                        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                        if parsed.tzinfo is None:
                            parsed = parsed.replace(tzinfo=timezone.utc)
                        stamps.append(parsed)
                    except ValueError:
                        pass
            span = (max(stamps) - min(stamps)).total_seconds() if len(stamps) >= 2 else 0.0
            real = len(wakes) >= 3 and span >= 86_400
            waiver = history.get("observationWaiver")
            waiver_recorded = (waiver.get("waived") is True if isinstance(waiver, dict)
                               else bool(isinstance(waiver, str) and waiver.strip()))
            formal_clean = history.get("formalG5ObservationWaived") is False
            c.add(history.get("formalG5ObservationWaived") is False,
                  "formalG5ObservationWaived = false (QA waiver never formal)",
                  history.get("formalG5ObservationWaived"))
            if real:
                c.add(True, ">= 3 empty-queue wakes span >= 86400 s",
                      f"{len(wakes)} wakes / {span:.0f}s")
                c.add(history.get("emptyQueueWakesWaived") in (False, None),
                      "waiver flag is not set when the real observation exists",
                      history.get("emptyQueueWakesWaived"))
            else:
                effective = (waiver_recorded and formal_clean
                             and history.get("emptyQueueWakesWaived") is True)
                if effective:
                    c.waive(">= 3 empty-queue wakes span >= 86400 s",
                            f"{len(wakes)} wakes / {span:.0f}s; explicit owner waiver, "
                            "243/244 + waiver, not 244/244")
                else:
                    c.add(False, ">= 3 empty-queue wakes span >= 86400 s",
                          f"{len(wakes)} wakes / {span:.0f}s; no effective explicit waiver")

    site_path = evidence / "site-event-export.json"
    site = read_json(site_path) if site_path.is_file() else None
    if not isinstance(site, dict):
        c.add(False, "site-event-export.json object present")
    else:
        events = site.get("events")
        c.add(isinstance(events, list), "site events list present", type(events).__name__)
        if isinstance(events, list):
            c.add(all(row.get("type") in CLOUD_EVENT_TYPES for row in events if isinstance(row, dict)),
                  "only the 9 G5 cloud event types are exported")
            c.add(all(row.get("source") == "cloud" for row in events if isinstance(row, dict)),
                  "every event source is cloud")
            c.add(len(events) == sum(len(types) for _, types in WORK_EVENTS),
                  "site export carries the full 11-event A/B/C sequence", len(events))
            by_run = {row.get("officialRunId"): row.get("step") for row in offline.get("runs", [])}
            for step, expected in WORK_EVENTS:
                observed = [row.get("type") for row in events
                            if isinstance(row, dict) and by_run.get(row.get("officialRunId")) == step]
                c.add(tuple(observed) == expected, f"site event order for {step}", observed)
            committed = next((row for row in events if row.get("type") == "feedback_committed"), {})
            readback = next((row for row in events if row.get("type") == "receipt_readback"), {})
            c.add(bool(first_text(committed.get("receiptId"))),
                  "event-level feedback_committed.receiptId present", committed.get("receiptId"))
            c.add(bool(first_text(readback.get("receiptId"))),
                  "event-level receipt_readback.receiptId present", readback.get("receiptId"))
            c.add(bool(first_text(readback.get("feedbackId"))),
                  "event-level receipt_readback.feedbackId present", readback.get("feedbackId"))
            if isinstance(receipt, dict):
                c.add(committed.get("receiptId") == readback.get("receiptId") == receipt.get("id"),
                      "event-level receiptId binds the feedbackReceipt.id")
                c.add(readback.get("feedbackId") == receipt.get("feedbackId"),
                      "event-level feedbackId binds the feedbackReceipt.feedbackId")

    # Two G3 roles only. Both absent signatures is an explicit unsigned label,
    # never a passed signature check and never a formal G5 claim.
    signed = []
    empty = []
    for role in QA_ROLES:
        path = evidence / f"{role}.sig"
        if path.is_file():
            if path.stat().st_size == 0:
                empty.append(role)
            else:
                signed.append(role)
    c.add(not empty, "no empty signature files", empty)
    if "signatureStatus" in manifest or "signatureRoles" in manifest:
        c.add(manifest.get("signatureStatus") == UNSIGNED
              and manifest.get("signatureRoles") == dict.fromkeys(QA_ROLES, "absent")
              and not signed and not empty, "unsigned label binds two absent signature roles")
    if require_signatures:
        missing = [role for role in QA_ROLES if role not in signed]
        if not missing:
            c.add(True, "two-role signatures present (work-auditor + site-auditor)", signed)
        elif len(missing) == len(QA_ROLES):
            c.waive("two-role signatures",
                    "unsigned (owner keys absent); NOT a signature pass and NOT formal G5")
        else:
            c.add(False, "partial signature set", signed)

    return c.report()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--qa-scoped", action="store_true",
                        help="required: this tool only ever builds/checks QA-scoped evidence")
    parser.add_argument("--check", type=Path, metavar="EVIDENCE_DIR")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--static-dir", type=Path, default=Path("static"))
    parser.add_argument("--allow-missing-signatures", action="store_true")
    parser.add_argument("--unsigned-keys-absent", action="store_true",
                        help="label the exported QA manifest with both signing roles absent")
    args = parser.parse_args(argv if argv is not None else None)

    if not args.qa_scoped:
        print("REFUSED: QA exporter requires --qa-scoped. A formal bundle is out of scope here "
              "and a QA bundle must never be checked without the QA flag.", file=sys.stderr)
        return 2
    try:
        if args.check:
            return check_qa(args.check.resolve(), not args.allow_missing_signatures)
        if args.build:
            require(args.run_dir is not None and args.out is not None,
                    "--build needs --run-dir and --out")
            build_qa(args.run_dir.resolve(), args.out.resolve(), args.static_dir.resolve(),
                     unsigned_keys_absent=args.unsigned_keys_absent)
            return 0
        parser.error("choose --check or --build")
    except Blocked as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(f"BLOCKED: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
