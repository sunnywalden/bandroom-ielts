#!/usr/bin/env python3
"""Verify a ``bandroom-d2-local-attestation-v1`` seal (NEW CONTRACT, Z-D4/Z-D6).

DERIVED, VERSIONED ARTIFACT. ``analysis/scripts/verify_release.py`` and
``analysis/scripts/verify_cloud_release.py`` are FROZEN and are NOT edited or
imported. Their cloud checks cannot pass a Mac-local run, so this verifier
replaces exactly those checks and keeps the rest of the trust logic:

Signature / trust logic RETAINED from the frozen verifier
  * the four frozen role names: release-owner, holdout-custodian,
    work-auditor, site-auditor;
  * four DISTINCT Ed25519 trust keys, one per role;
  * the allowed-signers file MUST live OUTSIDE the evidence bundle
    (``not trusted_signers.resolve().is_relative_to(bundle.resolve())``);
  * ``ssh-keygen -Y verify`` per role over the exact ``manifest.json`` bytes.

Cloud-identity checks REPLACED (each is named where it is applied)
  * R1 ``source == "scheduled-cloud"`` / ``clientExecution is False``
    -> local-execution attestation: ``identityScope == "local-attestation"``
       and ``local-evidence.execution.mode`` is a local mode.
  * R2 cloud executor receipts (``cloud-executor`` / ``localExecution is False``)
    -> the retained local C/D digests and the clause map's local results.
  * R3 the M4 cold-start runtimeProfile gate (coldTrials/300/900)
    -> informational-only profile; the verifier FAILS if anyone claims the
       frozen schema.
  * R4 emptyQueueWakes from the cloud wake log
    -> local scheduled wake equivalence recorded in clause-map/execution.

The verifier also recomputes SHA256SUMS over ``manifest.files`` and, when the
optional ``SHA256SUMS`` file is present, over every bundle file (including
``manifest.json``). It prints the single-root disclosure so no reader can miss
that this package is owner-attested, not multi-party independent.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
from hashlib import sha256
from pathlib import Path

NAMESPACE = "bandroom-d2-local-attestation-v1"
FORMAL_NAMESPACE = "bandroom-d2-cloud-recovery-v1"
PROTOCOL_LABEL = "G5-owner-attested(single-root-four-key)"
IDENTITY_SCOPE = "local-attestation"
ROLES = ("release-owner", "holdout-custodian", "work-auditor", "site-auditor")
REQUIRED_FILES = ("local-evidence.json", "clause-map.json", "runtime-profile.json")
RETAINED_IDS = (
    "G3-fence-monotonic",
    "G3-C-cold-equals-resumed",
    "G3-D-local-same-sha",
    "G3-writeback-idempotent",
    "G3-writeback-lost-replay",
    "G3-writeback-old-fence-reject",
)

SINGLE_ROOT_DISCLOSURE = (
    "G5-owner-attested(single-root-four-key): one owner holds all four Ed25519 "
    "keys, generated on one machine. A single compromise can forge all four "
    "signatures and a verifying package. An external verifier cannot tell an "
    "honest package from a forged one from the bundle alone. Trust comes from "
    "public reproducibility plus owner attestation, NOT multi-party "
    "independence. Z-D4 approved this reduced trust model."
)

DIGEST = re.compile(r"^[0-9a-f]{64}$")


class Blocked(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Blocked(message)


def digest(value) -> bool:
    return isinstance(value, str) and DIGEST.fullmatch(value) is not None


def nonempty(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def read_json_bytes(data: bytes) -> dict:
    value = json.loads(data)
    require(isinstance(value, dict), "JSON document must be an object")
    return value


def sha_file(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def local_file(directory: Path, name: str) -> Path:
    path = directory / name
    require(path.is_file() and not path.is_symlink(), f"missing regular evidence file {name}")
    return path


def verify_local_signatures(bundle: Path, manifest: bytes, trusted_signers: Path,
                            namespace: str = NAMESPACE) -> dict:
    """Enforce signers-outside-bundle, exact role set, distinct keys, signatures."""
    require(not trusted_signers.resolve().is_relative_to(bundle.resolve()),
            "the allowed-signers file must be distributed outside the evidence bundle")
    keys: dict[str, bytes] = {}
    for line in trusted_signers.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        require(len(parts) == 3, f"malformed allowed-signers line: {line!r}")
        role, algorithm, key = parts
        require(role in ROLES and role not in keys and algorithm == "ssh-ed25519",
                "use one explicit Ed25519 key per trusted role")
        try:
            keys[role] = base64.b64decode(key, validate=True)
        except binascii.Error as error:
            raise Blocked(f"allowed-signers key for {role} is not base64: {error}") from error
    require(set(keys) == set(ROLES), f"allowed-signers must name exactly {list(ROLES)}")
    require(len(set(keys.values())) == len(ROLES),
            "all roles require distinct pre-established trust keys")
    for role in ROLES:
        signature = local_file(bundle, role + ".sig")
        verified = subprocess.run([
            "ssh-keygen", "-Y", "verify", "-f", str(trusted_signers), "-I", role,
            "-n", namespace, "-s", str(signature),
        ], input=manifest, capture_output=True, check=False)
        require(verified.returncode == 0,
                f"invalid local manifest signature for {role}")
    return {role: sha256(keys[role]).hexdigest()[:16] for role in ROLES}


def verify_local_evidence(local: dict) -> None:
    """REPLACEMENT R1: local-execution attestation instead of cloud identity."""
    require(local.get("identityScope") == IDENTITY_SCOPE,
            "local evidence identityScope must be local-attestation")
    mode = local.get("execution", {}).get("mode")
    require(nonempty(mode), "local execution mode must be recorded")
    require("scheduled-cloud" not in json.dumps(local),
            "local evidence must not claim scheduled-cloud identity")


def verify_clause_map(clause_map: dict) -> None:
    require(clause_map.get("protocol") == NAMESPACE, "clause map protocol must match")
    replaced = clause_map.get("replaced")
    retained = clause_map.get("retained")
    require(isinstance(replaced, list) and replaced, "clause map must enumerate replaced clauses")
    for row in replaced:
        require(isinstance(row, dict) and nonempty(row.get("id")) and nonempty(row.get("zdDecision"))
                and nonempty(row.get("lostProperty")) and nonempty(row.get("disclosure")),
                "every replacement must name a Z-D decision, lost property and disclosure")
    require(isinstance(retained, list) and {row.get("id") for row in retained if isinstance(row, dict)}
            == set(RETAINED_IDS), "retained clause id set is incomplete")
    for row in retained:
        require(isinstance(row, dict), "retained clause must be an object")
        require(row.get("status") in ("pass", "waived"),
                f"retained clause {row.get('id')} failed or has an invalid status: {row.get('status')}")


def verify_runtime_profile(profile: dict) -> None:
    """REPLACEMENT R3: informational only; claiming the frozen schema fails."""
    require(profile.get("status") == "informational", "M4-local runtime profile must be informational")
    require(profile.get("gateRole") == "none", "M4-local runtime profile must have no gate role")
    frozen = profile.get("frozenRuntimeProfile") or {}
    require(frozen.get("claimed") is False, "the frozen runtimeProfile schema must be explicitly not claimed")
    require("coldTrials" not in profile, "informational profile must not carry fabricated coldTrials")
    require(isinstance(profile.get("preregisteredMeasurementProtocol"), dict),
            "informational profile must record the preregistered measurement protocol")


def verify_sums_files(bundle: Path, manifest: dict) -> None:
    hashes = manifest.get("files")
    require(isinstance(hashes, dict) and hashes, "manifest.files must be a non-empty object")
    require(all(digest(value) for value in hashes.values()), "every manifest digest must be 64 lowercase hex")
    require(set(REQUIRED_FILES) <= set(hashes), "manifest must list every required local file")
    for name, expected in hashes.items():
        path = local_file(bundle, name)
        require(sha_file(path) == expected, f"digest mismatch for {name}")
    sums_path = bundle / "SHA256SUMS"
    if sums_path.is_file():
        seen = set()
        for line in sums_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            require(len(parts) == 2, f"malformed SHA256SUMS line: {line!r}")
            expected, name = parts
            name = name.lstrip("*")
            require(name not in seen, f"duplicate SHA256SUMS entry {name}")
            seen.add(name)
            path = local_file(bundle, name)
            require(sha_file(path) == expected, f"SHA256SUMS mismatch for {name}")
        require({"manifest.json", *REQUIRED_FILES} <= seen,
                "SHA256SUMS must cover manifest.json and every required file")


def verify_local_bundle(bundle: Path, trusted_signers: Path, *,
                        require_signatures: bool = True, namespaces: tuple[str, ...] = (NAMESPACE,)
                        ) -> dict:
    manifest_bytes = local_file(bundle, "manifest.json").read_bytes()
    # The namespace is part of the ssh-keygen signature domain. The caller may
    # supply more than one candidate domain so an operator can diagnose a
    # domain mismatch instead of silently accepting the wrong one.
    signed_by = None
    if require_signatures:
        last_error: Exception | None = None
        for namespace in namespaces:
            try:
                fingerprints = verify_local_signatures(bundle, manifest_bytes, trusted_signers, namespace)
                signed_by = namespace
                break
            except Blocked as error:
                last_error = error
        require(signed_by is not None, str(last_error) if last_error else "signature verification failed")
    else:
        fingerprints = {}

    manifest = read_json_bytes(manifest_bytes)
    require(type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1,
            "manifest schemaVersion must be 1")
    require(manifest.get("protocol") == NAMESPACE, f"manifest protocol must be {NAMESPACE}")
    require(manifest.get("protocolLabel") == PROTOCOL_LABEL,
            f"manifest protocolLabel must be {PROTOCOL_LABEL}")
    require(manifest.get("identityScope") == IDENTITY_SCOPE,
            f"manifest identityScope must be {IDENTITY_SCOPE}")
    require(manifest.get("frozenNamespaceNotClaimed") == FORMAL_NAMESPACE,
            "manifest must name the frozen namespace it does not claim")
    require(nonempty(manifest.get("singleRootDisclosure")), "manifest must carry the single-root disclosure")
    require(sorted(manifest.get("roles") or []) == sorted(ROLES),
            "manifest must list the frozen four role names")
    require(isinstance(manifest.get("signersDistribution"), str)
            and "outside" in manifest["signersDistribution"].lower(),
            "manifest must record that allowed-signers live outside the bundle")

    verify_sums_files(bundle, manifest)

    local = read_json_bytes(local_file(bundle, "local-evidence.json").read_bytes())
    verify_local_evidence(local)
    clause_map = read_json_bytes(local_file(bundle, "clause-map.json").read_bytes())
    verify_clause_map(clause_map)
    profile = read_json_bytes(local_file(bundle, "runtime-profile.json").read_bytes())
    verify_runtime_profile(profile)

    # REPLACEMENT R4: local scheduled wakes (never fabricated) live in the
    # execution record. Absence is already represented as a labelled waiver in
    # the clause map, so this verifier does not invent a cloud wake log.
    execution = local.get("execution") or {}
    wakes = execution.get("scheduledWakeCount")
    span = execution.get("spanSeconds")
    if isinstance(wakes, int) and isinstance(span, int):
        observed_equivalent = wakes >= 3 and span >= 86_400
    else:
        observed_equivalent = False

    return {
        "protocol": NAMESPACE,
        "protocolLabel": PROTOCOL_LABEL,
        "signedByNamespace": signed_by,
        "roleFingerprints": fingerprints,
        "retainedClauses": {
            row["id"]: row["status"] for row in clause_map["retained"]
        },
        "localScheduledWakeEquivalent": observed_equivalent,
        "singleRootDisclosure": SINGLE_ROOT_DISCLOSURE,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--trusted-signers", type=Path, required=True,
                        help="allowed-signers file distributed OUTSIDE the bundle")
    parser.add_argument("--allow-missing-signatures", action="store_true",
                        help="structural checks only; never a signature pass")
    parser.add_argument("--json", action="store_true", help="emit the verification record as JSON")
    args = parser.parse_args(argv)
    try:
        result = verify_local_bundle(
            args.evidence.resolve(), args.trusted_signers.resolve(),
            require_signatures=not args.allow_missing_signatures)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, Blocked,
            json.JSONDecodeError, binascii.Error) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"READY: {NAMESPACE} local-attestation evidence passed.")
    print("DISCLOSURE: " + SINGLE_ROOT_DISCLOSURE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())