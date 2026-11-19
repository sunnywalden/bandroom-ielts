#!/usr/bin/env python3
"""Sign a local-attestation bundle and split public vs private seal artifacts.

The exporter never signs (same rule as the frozen exporter). This tool is the
separate four-role signing / seal step. It writes the four detached signatures
into the PRIVATE bundle and copies only the PUBLIC artifacts to the public
directory:

  PRIVATE (never published):   <bundle>/manifest.json, evidence files,
                               <role>.sig x4, SHA256SUMS
  PUBLIC (safe to distribute): <public>/verify_local_release.py,
                               <public>/manifest.sha256,
                               <public>/SHA256SUMS,
                               <public>/keys/<role>.pub,
                               <public>/keys/key-manifest.json

The allowed-signers file is NOT copied into the public dir by default: it must
be distributed outside the evidence bundle via a separate channel (frozen N10).
An external verifier can also rebuild it from the published public keys.

This tool signs the exact manifest.json bytes with each role's Ed25519 key. It
never prints private key material and never copies a private key anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from hashlib import sha256
from pathlib import Path

NAMESPACE = "bandroom-d2-local-attestation-v1"
ROLES = ("release-owner", "holdout-custodian", "work-auditor", "site-auditor")

PUBLIC_FILES = ("verify_local_release.py", "manifest.sha256", "SHA256SUMS")
SCRIPT_DIR = Path(__file__).resolve().parent


class Blocked(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Blocked(message)


def sha_file(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def sign_manifest(key_path: Path, manifest_bytes: bytes, namespace: str = NAMESPACE) -> bytes:
    """Detached signature over the exact manifest bytes via ssh-keygen stdin."""
    require(key_path.is_file(), f"missing private key {key_path}")
    result = subprocess.run(
        ["ssh-keygen", "-Y", "sign", "-f", str(key_path), "-n", namespace, "-"],
        input=manifest_bytes, capture_output=True, check=False)
    require(result.returncode == 0,
            f"ssh-keygen signing failed for {key_path.name}: {result.stderr.decode(errors='replace')[:200]}")
    require(result.stdout.startswith(b"-----BEGIN SSH SIGNATURE-----"),
            "ssh-keygen did not return a detached signature")
    return result.stdout


def ensure_outside_bundle(path: Path, bundle: Path) -> None:
    require(not path.resolve().is_relative_to(bundle.resolve()),
            f"{path} must not live inside the evidence bundle")


def write_sums(bundle: Path, public_dir: Path) -> str:
    names = ["manifest.json", *sorted(
        path.name for path in bundle.iterdir()
        if path.is_file() and path.name not in ("manifest.json", "SHA256SUMS"))]
    lines = [f"{sha_file(bundle / name)}  {name}" for name in names]
    text = "\n".join(lines) + "\n"
    (bundle / "SHA256SUMS").write_text(text, encoding="utf-8")
    (public_dir / "SHA256SUMS").write_text(text, encoding="utf-8")
    return sha_file(bundle / "manifest.json")


def seal(bundle: Path, keys_root: Path, public_dir: Path, *,
         copy_signers: Path | None = None, namespace: str = NAMESPACE) -> dict:
    bundle = bundle.resolve()
    public_dir = public_dir.resolve()
    ensure_outside_bundle(public_dir, bundle)
    if copy_signers is not None:
        ensure_outside_bundle(copy_signers, bundle)
        require(copy_signers.is_file(), f"allowed-signers file not found: {copy_signers}")

    manifest_path = bundle / "manifest.json"
    require(manifest_path.is_file(), "bundle has no manifest.json to sign")
    manifest_bytes = manifest_path.read_bytes()

    for role in ROLES:
        key_path = keys_root / role / "id_ed25519"
        signature = sign_manifest(key_path, manifest_bytes, namespace)
        (bundle / f"{role}.sig").write_bytes(signature)
        os.chmod(bundle / f"{role}.sig", 0o644)

    public_dir.mkdir(parents=True, exist_ok=True)
    verifier = SCRIPT_DIR / "verify_local_release.py"
    require(verifier.is_file(), "verify_local_release.py is missing next to this tool")
    shutil.copyfile(verifier, public_dir / "verify_local_release.py")
    manifest_sha = write_sums(bundle, public_dir)
    (public_dir / "manifest.sha256").write_text(manifest_sha + "  manifest.json\n", encoding="utf-8")

    keys_public = keys_root.parent / "public"
    if keys_public.is_dir():
        target = public_dir / "keys"
        target.mkdir(parents=True, exist_ok=True)
        for path in keys_public.iterdir():
            if path.is_file():
                shutil.copyfile(path, target / path.name)

    if copy_signers is not None:
        shutil.copyfile(copy_signers, public_dir / "allowed-signers")

    return {
        "protocol": NAMESPACE,
        "manifestSha256": manifest_sha,
        "signedRoles": list(ROLES),
        "bundle": str(bundle),
        "public": str(public_dir),
        "signersCopied": copy_signers is not None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--keys-root", type=Path,
                        default=Path.home() / ".bandroom-g5-local" / "keys")
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--signers", type=Path, default=None,
                        help="optional allowed-signers copy (stays outside the bundle)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = seal(args.bundle, args.keys_root, args.public, copy_signers=args.signers)
    except (Blocked, OSError, subprocess.SubprocessError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"signed manifest.json with four roles: {', '.join(result['signedRoles'])}")
    print(f"public artifacts: {result['public']} (verifier + manifest hashes + public keys)")
    print("private bundle and signatures stay private; allowed-signers stays outside the bundle")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())