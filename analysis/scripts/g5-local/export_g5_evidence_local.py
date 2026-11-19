#!/usr/bin/env python3
"""G3-local / G5-owner-attested evidence exporter (NEW CONTRACT, Z-D4/Z-D5/Z-D6).

DERIVED, VERSIONED ARTIFACT. The formal G5 exporter
``acceptance-2026-11-10/iteration-23/run-side/export_g5_evidence.py`` and the
formal verifiers (``analysis/scripts/verify_cloud_release.py``,
``analysis/scripts/verify_release.py``) are FROZEN and are NOT edited. The
frozen verifier hardcodes cloud identity (``source == "scheduled-cloud"``,
``clientExecution is False``, ``cloud-executor``, ``localExecution is False``),
so a Mac-local run can never pass it. That is exactly why this is a NEW
contract, not a re-verification. This file follows the derivation precedent of
``analysis/scripts/g3-fix/export_g5_evidence_qa.py``.

New namespace: ``bandroom-d2-local-attestation-v1``
Protocol label: ``G5-owner-attested(single-root-four-key)``
Identity scope: ``local-attestation``

What this exporter does
-----------------------
* Keeps the frozen four role names (release-owner, holdout-custodian,
  work-auditor, site-auditor) verbatim; the keys themselves are generated
  locally by ``gen_local_keys.py`` and never enter this bundle.
* Emits an explicit G3-local clause map (``clause-map.json``): every replaced
  clause names the Z-D decision that authorised it and the lost property, and
  every retained clause is evaluated from local evidence as pass / fail /
  waived. Nothing is fabricated; an unmeasured clause becomes a labelled
  waiver, never a pass.
* Emits an INFORMATIONAL M4-local runtime profile
  (``runtime-profile.json``, Z-D5). It documents the preregistered measurement
  protocol and explicitly declares that the frozen ``coldTrials >= 3`` /
  ``300 s`` / ``900 s`` schema is NOT filled. It is not a pass/fail gate.
* Emits the single-root disclosure in the manifest: one compromise forges all
  four signatures and a verifying package; external verifiers cannot tell an
  honest from a forged package from the bundle alone. Trust comes from public
  reproducibility plus owner attestation, not multi-party independence.
* Has a separate ``check_local()``. The frozen ``check()`` is not branched and
  is not imported.

This tool never contacts the network, never signs, and never reads a private
key. Signing is a separate four-role operation with keys outside the bundle
(see ``gen_local_keys.py`` / ``seal_local_bundle.py``).
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

NAMESPACE = "bandroom-d2-local-attestation-v1"
FORMAL_NAMESPACE = "bandroom-d2-cloud-recovery-v1"
PROTOCOL_LABEL = "G5-owner-attested(single-root-four-key)"
IDENTITY_SCOPE = "local-attestation"
SCHEMA_VERSION = 1

# The frozen four role names (verify_release.ROLES). Order is significant.
ROLES = ("release-owner", "holdout-custodian", "work-auditor", "site-auditor")

# Evidence files every local bundle carries. Optional binaries are added when
# actually supplied; they are never synthesized.
LOCAL_FILES = ("local-evidence.json", "clause-map.json", "runtime-profile.json")
OPTIONAL_BINARIES = ("cold-output.bin", "resumed-output.bin", "d-local-output.bin")

SINGLE_ROOT_DISCLOSURE = (
    "G5-owner-attested(single-root-four-key): all four Ed25519 keys were "
    "generated on one machine and are held by one owner. A single compromise "
    "can forge all four signatures and a package that passes verification. "
    "An external verifier cannot distinguish an honest package from a forged "
    "one from the bundle alone. Trust rests on public reproducibility plus the "
    "owner's attestation, NOT on multi-party independence. Z-D4 approved this "
    "reduced trust model; Z-D9 (independent-device key) is optional and, if "
    "declined, this disclosure is the final state."
)

SIGNERS_OUTSIDE_RULE = (
    "The allowed-signers file MUST be distributed outside the evidence bundle "
    "(frozen N10 / verify_release.py:100-112). This manifest never embeds it."
)

DIGEST = re.compile(r"^[0-9a-f]{64}$")

# --------------------------------------------------------------------------
# G3-local clause map (rev2 section 8.2)
# --------------------------------------------------------------------------

REPLACED_CLAUSES = (
    {
        "id": "G3-M9-no-host",
        "frozenClause": "M9: work executes only off-host; no local execution is the subject",
        "localClause": "local runner execution IS the primary subject",
        "zdDecision": "Z-D6",
        "status": "replaced",
        "lostProperty": "the cloud-only no-host guarantee",
        "disclosure": "Local execution cannot prove the retired cloud-only property; it proves the retained byte-level clauses on this host instead.",
    },
    {
        "id": "G3-scheduled-cloud-identity",
        "frozenClause": "scheduled-cloud identity: source == 'scheduled-cloud', clientExecution is False, A/B/C three consecutive scheduled tasks",
        "localClause": "local runner scheduling equivalent (distinct scheduled wakes, no approval prompts)",
        "zdDecision": "Z-D6",
        "status": "replaced",
        "lostProperty": "vendor-side scheduling and independent cloud runner records",
        "disclosure": "The local scheduler's wake records are the substitute; external verifiers cannot corroborate them against a cloud provider.",
    },
    {
        "id": "G3-chrome-5.2-two-human",
        "frozenClause": "Chrome section 5.2: two independent human listeners across two encodings",
        "localClause": "machine-panel double-codec check",
        "zdDecision": "Z-D6",
        "status": "replaced",
        "lostProperty": "two independent human listening judgements",
        "disclosure": "Z-D6-approved substitution, NOT a silent waiver. A machine panel is not human independence and is labelled as such.",
    },
    {
        "id": "G3-M4-matrix",
        "frozenClause": "M4 cold-start matrix (coldTrials >= 3 per encoding, download+prepare <= 300 s, total <= 900 s)",
        "localClause": "M4-local is INFORMATIONAL under a preregistered measurement protocol",
        "zdDecision": "Z-D5",
        "status": "replaced-by-informational",
        "lostProperty": "the pass/fail cold-start budget",
        "disclosure": "Not a gate. The frozen runtimeProfile schema is explicitly NOT filled; see runtime-profile.json.",
    },
    {
        "id": "G3-D-cloud-bytes",
        "frozenClause": "D: cloud-bytes reference run (cloud download returned 403, 0/12 artifacts missing)",
        "localClause": "D-local: local assets are complete, so a second-process cold reference is computable",
        "zdDecision": "Z-D6",
        "status": "replaced",
        "lostProperty": "vendor-object-store round trip",
        "disclosure": "D-local is a same-host second-process determinism check, NOT independent-party replication.",
    },
)

RETAINED_CLAUSES = (
    {
        "id": "G3-fence-monotonic",
        "clause": "lease fence is monotonic",
        "evidenceKey": "fence",
    },
    {
        "id": "G3-C-cold-equals-resumed",
        "clause": "C cold == resumed, byte-equal",
        "evidenceKey": "coldResumed",
    },
    {
        "id": "G3-D-local-same-sha",
        "clause": "D-local second process yields the same output SHA",
        "evidenceKey": "dLocal",
    },
    {
        "id": "G3-writeback-idempotent",
        "clause": "writeback is idempotent",
        "evidenceKey": "writeback.idempotent",
    },
    {
        "id": "G3-writeback-lost-replay",
        "clause": "lost response replay returns the same receipt / output",
        "evidenceKey": "writeback.lostReplayRedelivered",
    },
    {
        "id": "G3-writeback-old-fence-reject",
        "clause": "a writeback carrying an old fence is rejected",
        "evidenceKey": "writeback.oldFenceRejected",
    },
)
RETAINED_IDS = tuple(row["id"] for row in RETAINED_CLAUSES)

ZD_APPROVALS = {
    "Z-D4": "G5-owner-attested(single-root-four-key) trust model, lost properties disclosed",
    "Z-D5": "M4-local reduced to informational under a preregistered protocol",
    "Z-D6": "G3-local/G5-local new-contract substitutions, enumerated clause by clause",
    "Z-D8": "git/PR/merge + named single Worker deploy + seal issuance authorisation",
}


class Blocked(Exception):
    """A precondition failed. Nothing is fabricated to get past it."""


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
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                    encoding="utf-8")


def sha_file(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def digest(value) -> bool:
    return isinstance(value, str) and DIGEST.fullmatch(value) is not None


def nonempty(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def first_text(*values):
    for value in values:
        if nonempty(value):
            return value.strip()
    return None


def first_int(*values):
    for value in values:
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def get_path(obj, dotted: str, default=None):
    current = obj
    for key in dotted.split("."):
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def utc(value) -> datetime | None:
    if not nonempty(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Retained-clause evaluation. Missing evidence is a labelled waiver, not a pass.
# --------------------------------------------------------------------------

def evaluate_clause(clause_id: str, evidence: dict) -> dict:
    """Return {status, detail} for one retained clause.

    ``status`` is 'pass', 'fail' or 'waived'. A waived clause is explicit and
    is never counted as a pass by check_local().
    """
    if clause_id == "G3-fence-monotonic":
        sequence = get_path(evidence, "fence.sequence")
        if not isinstance(sequence, list) or not sequence:
            return {"status": "waived", "detail": "no lease-fence sequence supplied"}
        values = [row for row in sequence if isinstance(row, int) and not isinstance(row, bool)]
        ok = len(values) == len(sequence) and all(v >= 1 for v in values) \
            and values == sorted(values) and len(set(values)) == len(values)
        return {"status": "pass" if ok else "fail", "detail": f"fences={sequence}"}

    if clause_id == "G3-C-cold-equals-resumed":
        cold = get_path(evidence, "coldResumed.coldOutputSha256")
        resumed = get_path(evidence, "coldResumed.resumedOutputSha256")
        if not (digest(cold) and digest(resumed)):
            return {"status": "waived", "detail": "cold/resumed output digests not supplied"}
        ok = cold == resumed and get_path(evidence, "coldResumed.coldEqualsResumed") is not False
        return {"status": "pass" if ok else "fail", "detail": f"cold={cold} resumed={resumed}"}

    if clause_id == "G3-D-local-same-sha":
        cold = get_path(evidence, "coldResumed.coldOutputSha256")
        dlocal = get_path(evidence, "dLocal.coldOutputSha256")
        flag = get_path(evidence, "dLocal.sameShaAsResumed")
        independent = get_path(evidence, "dLocal.independentProcess")
        if not (digest(cold) and digest(dlocal)):
            return {"status": "waived", "detail": "D-local output digest not supplied"}
        ok = cold == dlocal and flag is not False and independent is not False
        detail = f"resumed/cold={cold} d-local={dlocal}; same-host second process, not independent-party replication"
        return {"status": "pass" if ok else "fail", "detail": detail}

    if clause_id == "G3-writeback-idempotent":
        return _bool_clause(evidence, "writeback.idempotent", "writeback idempotence")
    if clause_id == "G3-writeback-lost-replay":
        return _bool_clause(evidence, "writeback.lostReplayRedelivered", "lost-replay redelivery")
    if clause_id == "G3-writeback-old-fence-reject":
        return _bool_clause(evidence, "writeback.oldFenceRejected", "old-fence rejection")
    raise Blocked(f"unknown retained clause {clause_id}")


def _bool_clause(evidence: dict, dotted: str, label: str) -> dict:
    value = get_path(evidence, dotted)
    if value is None:
        return {"status": "waived", "detail": f"{label} not measured locally"}
    return {"status": "pass" if value is True else "fail", "detail": f"{label}={value!r}"}


# --------------------------------------------------------------------------
# Composition
# --------------------------------------------------------------------------

def compose_local_evidence(run: dict) -> dict:
    """Normalise the supplied local run evidence. Nothing is invented."""
    require(run.get("schemaVersion") in (None, SCHEMA_VERSION), "local run schemaVersion must be 1")
    execution = run.get("execution") if isinstance(run.get("execution"), dict) else {}
    recording = run.get("recording") if isinstance(run.get("recording"), dict) else {}
    evidence = {
        "schema": "bandroom.g5-local.local-evidence.v1",
        "identityScope": IDENTITY_SCOPE,
        "analysisVersion": first_text(run.get("analysisVersion"), IDENTITY_SCOPE),
        "environmentId": first_text(run.get("environmentId"), IDENTITY_SCOPE),
        "recording": {
            "recordingSha256": first_text(recording.get("recordingSha256")),
            "inputBytes": first_int(recording.get("inputBytes")),
        },
        "execution": {
            "mode": first_text(execution.get("mode"), "local-runner"),
            "scheduledWakeCount": first_int(execution.get("scheduledWakeCount")),
            "spanSeconds": first_int(execution.get("spanSeconds")),
            "approvalPrompts": first_int(execution.get("approvalPrompts")),
            "failClosed": execution.get("failClosed") if isinstance(execution.get("failClosed"), bool) else None,
        },
        "fence": run.get("fence") if isinstance(run.get("fence"), dict) else {},
        "coldResumed": run.get("coldResumed") if isinstance(run.get("coldResumed"), dict) else {},
        "dLocal": run.get("dLocal") if isinstance(run.get("dLocal"), dict) else {},
        "writeback": run.get("writeback") if isinstance(run.get("writeback"), dict) else {},
        "sourceProvenance": run.get("sourceProvenance") if isinstance(run.get("sourceProvenance"), dict) else {},
        "inputWaivers": [row for row in run.get("waivers", []) if isinstance(row, dict)]
        if isinstance(run.get("waivers"), list) else [],
    }
    # Keep the D-local disclosure attached to the evidence, not only to the map.
    if evidence["dLocal"] and "disclosure" not in evidence["dLocal"]:
        evidence["dLocal"]["disclosure"] = (
            "same-host second process = determinism check, NOT independent-party replication"
        )
    return evidence


def compose_clause_map(evidence: dict) -> dict:
    retained = []
    for clause in RETAINED_CLAUSES:
        result = evaluate_clause(clause["id"], evidence)
        retained.append({**clause, **result})
    waivers = [
        {
            "clause": row["id"],
            "status": row["status"],
            "detail": row["detail"],
        }
        for row in retained if row["status"] == "waived"
    ]
    return {
        "schema": "bandroom.g5-local.clause-map.v1",
        "protocol": NAMESPACE,
        "protocolLabel": PROTOCOL_LABEL,
        "frozenNamespaceNotClaimed": FORMAL_NAMESPACE,
        "frozenToolsUntouched": [
            "acceptance-2026-11-10/iteration-23/run-side/export_g5_evidence.py",
            "analysis/scripts/verify_cloud_release.py",
            "analysis/scripts/verify_release.py",
            "analysis/scripts/calibration-gates/v3_gate.py",
            "analysis/scripts/calibration-gates/v3_personal_gate.py",
        ],
        "zdApprovals": ZD_APPROVALS,
        "replaced": [dict(row) for row in REPLACED_CLAUSES],
        "retained": retained,
        "waivers": waivers,
        "independentColdDisclosure": (
            "D-local is a same-host second-process determinism check. It is NOT "
            "independent-party replication (rev2 section 8.2)."
        ),
    }


def compose_runtime_profile(run: dict) -> dict:
    """INFORMATIONAL M4-local profile (Z-D5). Never a pass/fail gate."""
    supplied = run.get("m4LocalMeasurements")
    measurements = supplied if isinstance(supplied, dict) else None
    return {
        "schema": "bandroom.g5-local.runtime-profile-informational.v1",
        "status": "informational",
        "gateRole": "none",
        "zdDecision": "Z-D5",
        "frozenRuntimeProfile": {
            "sourceSchema": (
                "acceptance-2026-11-10/iteration-23/run-side/"
                "g5-evidence-export.schema.json#runtimeProfile"
            ),
            "claimed": False,
            "unfilledFields": [
                "coldTrials >= 3 per encoding (mp4/aac, webm/opus)",
                "stageSeconds with exactly 8 keys",
                "download + prepare <= 300 s",
                "total <= executionSeconds <= 900 s",
            ],
            "reason": (
                "The M4 cloud cold-start matrix retired with the cloud "
                "architecture. Z-D5 makes M4-local informational; this file "
                "does not pretend to fill the frozen schema."
            ),
        },
        "preregisteredMeasurementProtocol": {
            "executed": measurements is not None,
            "freshVm": True,
            "pipCacheCleared": True,
            "modelCacheCleared": True,
            "weightsInclusion": {
                "mustBeStated": True,
                "allowedValues": ["included-in-download", "excluded-pre-seeded"],
                "statement": (
                    "A future M4-local measurement must state whether model "
                    "weights are included in the cold download or pre-seeded."
                ),
            },
            "coldTrialsPerEncoding": 3,
            "encodings": ["mp4/aac", "webm/opus"],
            "downloadPrepareBudgetSeconds": 300,
            "totalBudgetSeconds": 900,
        },
        "measurements": measurements,
        "informationalOnly": True,
        "waiver": {
            "kind": "informational-not-measured" if measurements is None else "informational-measured-not-a-gate",
            "disclosure": (
                "M4-local is informational. A value here can never make this "
                "bundle pass or fail; the retained byte-level clauses are the "
                "contract."
            ),
        },
    }


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def build_local(run_dir: Path, out: Path, static: Path | None = None, *,
                unsigned_keys_absent: bool = False) -> None:
    run = read_json(run_dir / "local-run.json")
    resolved_static = static or run_dir
    evidence = compose_local_evidence(run)
    clause_map = compose_clause_map(evidence)
    runtime_profile = compose_runtime_profile(run)

    out.mkdir(parents=True, exist_ok=False)
    write_json(out / "local-evidence.json", evidence)
    write_json(out / "clause-map.json", clause_map)
    write_json(out / "runtime-profile.json", runtime_profile)

    written = list(LOCAL_FILES)
    for name in OPTIONAL_BINARIES:
        source = resolved_static / name
        if source.is_file():
            copyfile(source, out / name)
            written.append(name)

    files = {name: sha_file(out / name) for name in written}
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": NAMESPACE,
        "protocolLabel": PROTOCOL_LABEL,
        "identityScope": IDENTITY_SCOPE,
        "frozenNamespaceNotClaimed": FORMAL_NAMESPACE,
        "analysisVersion": evidence["analysisVersion"],
        "environmentId": evidence["environmentId"],
        "files": files,
        "roles": list(ROLES),
        "signatureScheme": "ssh-ed25519 detached over manifest.json bytes",
        "signersDistribution": SIGNERS_OUTSIDE_RULE,
        "singleRootDisclosure": SINGLE_ROOT_DISCLOSURE,
        "clauseMap": {
            "replaced": [row["id"] for row in REPLACED_CLAUSES],
            "retained": list(RETAINED_IDS),
        },
        "m4Local": {"status": "informational", "gateRole": "none", "zdDecision": "Z-D5"},
    }
    if unsigned_keys_absent:
        manifest["signatureStatus"] = "unsigned-keys-absent"
        manifest["signatureRoles"] = dict.fromkeys(ROLES, "absent")
    write_json(out / "manifest.json", manifest)
    print(f"wrote local-attestation bundle {out} with {len(written)} files (protocol {NAMESPACE})")
    print("G5-owner-attested(single-root-four-key): NOT multi-party independence.")
    print("next: four detached Ed25519 signatures; keys and allowed-signers stay OUTSIDE the bundle")


# --------------------------------------------------------------------------
# check_local (separate from the frozen formal check())
# --------------------------------------------------------------------------

class Checks:
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


def check_local(evidence_dir: Path, require_signatures: bool = True) -> int:
    """Validate a ``bandroom-d2-local-attestation-v1`` bundle only."""
    c = Checks("G3-local / G5-owner-attested local bundle")

    manifest_path = evidence_dir / "manifest.json"
    if not manifest_path.is_file():
        print("FAIL  manifest.json missing")
        return 1
    try:
        manifest = read_json(manifest_path)
    except Blocked as error:
        print(f"FAIL  {error}")
        return 1

    c.add(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == SCHEMA_VERSION,
          "schemaVersion must be 1", manifest.get("schemaVersion"))
    c.add(manifest.get("protocol") == NAMESPACE, f"protocol must be {NAMESPACE}", manifest.get("protocol"))
    c.add(manifest.get("protocolLabel") == PROTOCOL_LABEL,
          f"protocolLabel must be {PROTOCOL_LABEL}", manifest.get("protocolLabel"))
    c.add(manifest.get("identityScope") == IDENTITY_SCOPE,
          f"identityScope must be {IDENTITY_SCOPE}", manifest.get("identityScope"))
    c.add(manifest.get("frozenNamespaceNotClaimed") == FORMAL_NAMESPACE,
          "manifest names the frozen namespace it does not claim")
    c.add(isinstance(manifest.get("singleRootDisclosure"), str)
          and "single-root" in manifest["singleRootDisclosure"],
          "single-root disclosure present")
    c.add(isinstance(manifest.get("signersDistribution"), str)
          and "outside" in manifest["signersDistribution"].lower(),
          "signers-outside-bundle rule recorded")
    c.add(sorted(manifest.get("roles") or []) == sorted(ROLES),
          "manifest lists the frozen four role names", manifest.get("roles"))

    hashes = manifest.get("files")
    c.add(isinstance(hashes, dict), "manifest.files object present", type(hashes).__name__)
    if not isinstance(hashes, dict):
        return c.report()
    c.add(all(digest(value) for value in hashes.values()), "every manifest digest is 64 lowercase hex")
    c.add(set(LOCAL_FILES) <= set(hashes), "manifest lists every required local file",
          sorted(set(LOCAL_FILES) - set(hashes)))
    c.add(set(hashes) <= set(LOCAL_FILES) | set(OPTIONAL_BINARIES),
          "manifest lists only known local file names",
          sorted(set(hashes) - set(LOCAL_FILES) - set(OPTIONAL_BINARIES)))
    for name, expected in sorted(hashes.items()):
        path = evidence_dir / name
        if not path.is_file():
            c.add(False, f"listed file present: {name}")
        else:
            c.add(sha_file(path) == expected, f"digest matches: {name}")

    # Clause map: replacements disclosed, retained clauses not fabricated.
    clause_map = read_json(evidence_dir / "clause-map.json") if (evidence_dir / "clause-map.json").is_file() else None
    if not isinstance(clause_map, dict):
        c.add(False, "clause-map.json object present")
    else:
        c.add(clause_map.get("protocol") == NAMESPACE, "clause map protocol matches")
        replaced = clause_map.get("replaced")
        c.add(isinstance(replaced, list) and len(replaced) == len(REPLACED_CLAUSES),
              "all replaced clauses enumerated", len(replaced) if isinstance(replaced, list) else None)
        if isinstance(replaced, list):
            c.add(all(nonempty(row.get("zdDecision")) and nonempty(row.get("disclosure"))
                      and nonempty(row.get("lostProperty")) for row in replaced if isinstance(row, dict)),
                  "every replacement names a Z-D decision, lost property and disclosure")
            c.add({row.get("id") for row in replaced if isinstance(row, dict)}
                  == {row["id"] for row in REPLACED_CLAUSES},
                  "replaced clause id set is complete")
        retained = clause_map.get("retained")
        c.add(isinstance(retained, list) and {row.get("id") for row in retained if isinstance(row, dict)}
              == set(RETAINED_IDS), "retained clause id set is complete",
              [row.get("id") for row in retained] if isinstance(retained, list) else None)
        if isinstance(retained, list):
            for row in retained:
                if not isinstance(row, dict):
                    c.add(False, "retained clause is an object")
                    continue
                status = row.get("status")
                if status == "fail":
                    c.add(False, f"retained clause {row.get('id')} evaluated FAIL", row.get("detail"))
                elif status == "waived":
                    c.waive(f"retained clause {row.get('id')} (explicit waiver)", row.get("detail"))
                elif status == "pass":
                    c.add(True, f"retained clause {row.get('id')} evaluated PASS", row.get("detail"))
                else:
                    c.add(False, f"retained clause {row.get('id')} status invalid", status)

    # Runtime profile must be informational, never a fake frozen runtimeProfile.
    profile = read_json(evidence_dir / "runtime-profile.json") \
        if (evidence_dir / "runtime-profile.json").is_file() else None
    if not isinstance(profile, dict):
        c.add(False, "runtime-profile.json object present")
    else:
        c.add(profile.get("status") == "informational", "M4-local profile status is informational",
              profile.get("status"))
        c.add(profile.get("gateRole") == "none", "M4-local profile has no gate role", profile.get("gateRole"))
        c.add(get_path(profile, "frozenRuntimeProfile.claimed") is False,
              "frozen runtimeProfile schema is explicitly not claimed")
        c.add("coldTrials" not in profile, "informational profile does not carry fabricated coldTrials")
        c.add(isinstance(profile.get("preregisteredMeasurementProtocol"), dict),
              "preregistered measurement protocol present")

    # Local evidence: identity scope and no fabricated cloud claims.
    local = read_json(evidence_dir / "local-evidence.json") \
        if (evidence_dir / "local-evidence.json").is_file() else None
    if not isinstance(local, dict):
        c.add(False, "local-evidence.json object present")
    else:
        c.add(local.get("identityScope") == IDENTITY_SCOPE, "local evidence identityScope is local-attestation")
        mode = get_path(local, "execution.mode")
        c.add(nonempty(mode), "local execution mode recorded", mode)
        c.add("scheduled-cloud" not in json.dumps(local), "local evidence does not claim scheduled-cloud identity")
        recording_sha = get_path(local, "recording.recordingSha256")
        if recording_sha is not None:
            c.add(digest(recording_sha), "recording sha is 64 hex", recording_sha)

    # Signatures: present means four non-empty role files. Absent is an explicit
    # unsigned label only when allowed; otherwise it is a failure.
    signed, empty = [], []
    for role in ROLES:
        path = evidence_dir / f"{role}.sig"
        if path.is_file():
            (empty if path.stat().st_size == 0 else signed).append(role)
    c.add(not empty, "no empty signature files", empty)
    if "signatureStatus" in manifest or "signatureRoles" in manifest:
        c.add(manifest.get("signatureStatus") == "unsigned-keys-absent"
              and manifest.get("signatureRoles") == dict.fromkeys(ROLES, "absent"),
              "unsigned label binds four absent roles")
    if require_signatures:
        missing = [role for role in ROLES if role not in signed]
        if missing:
            c.add(False, "all four role signatures present", missing)
        else:
            c.add(True, "four role signatures present", signed)

    return c.report()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", type=Path, metavar="EVIDENCE_DIR")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--static-dir", type=Path, default=None)
    parser.add_argument("--allow-missing-signatures", action="store_true")
    parser.add_argument("--unsigned-keys-absent", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.check:
            return check_local(args.check.resolve(), not args.allow_missing_signatures)
        if args.build:
            require(args.run_dir is not None and args.out is not None,
                    "--build needs --run-dir and --out")
            build_local(args.run_dir.resolve(), args.out.resolve(),
                        args.static_dir.resolve() if args.static_dir else None,
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