#!/usr/bin/env python3
"""Generate the four local Ed25519 keys for ``bandroom-d2-local-attestation-v1``.

One distinct Ed25519 key per frozen role (release-owner, holdout-custodian,
work-auditor, site-auditor), all generated on this machine. This is the
single-root model approved by Z-D4; see the disclosure in the manifest and
README.

Layout (defaults, all outside any evidence bundle and outside the repo):

  ~/.bandroom-g5-local/keys/<role>/id_ed25519       0600  PRIVATE, never printed
  ~/.bandroom-g5-local/keys/<role>/id_ed25519.pub   0644
  ~/.bandroom-g5-local/public/<role>.pub            0644  copy for distribution
  ~/.bandroom-g5-local/public/key-manifest.json     0644  role -> public key/fingerprint
  ~/.bandroom-g5-local/allowed-signers              0644  "<role> ssh-ed25519 <base64>"

Rules enforced here:
  * four DISTINCT public keys (no role reuses another's key);
  * private keys live in separate 0700 directories, never in the repo and
    never in the bundle;
  * the public directory and the allowed-signers file must not be inside a
    bundle directory when ``--bundle`` is supplied (frozen N10);
  * the tool prints only fingerprints and public paths, never private bytes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

NAMESPACE = "bandroom-d2-local-attestation-v1"
ROLES = ("release-owner", "holdout-custodian", "work-auditor", "site-auditor")

DEFAULT_ROOT = Path.home() / ".bandroom-g5-local" / "keys"
DEFAULT_PUBLIC = Path.home() / ".bandroom-g5-local" / "public"
DEFAULT_SIGNERS = Path.home() / ".bandroom-g5-local" / "allowed-signers"


class Blocked(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Blocked(message)


def ssh_keygen() -> str:
    binary = shutil.which("ssh-keygen")
    require(binary is not None, "ssh-keygen is required but was not found on PATH")
    return binary


def run(command: list[str]) -> subprocess.CompletedProcess:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    return result


def generate_key(keygen: str, role: str, key_path: Path, *, force: bool = False) -> None:
    key_dir = key_path.parent
    key_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(key_dir, 0o700)
    if key_path.exists() or Path(str(key_path) + ".pub").exists():
        require(force, f"refusing to overwrite existing key for {role} at {key_dir} (use --force)")
        for path in (key_path, Path(str(key_path) + ".pub")):
            if path.exists():
                path.unlink()
    result = run([keygen, "-q", "-t", "ed25519", "-N", "", "-C",
                  f"{role} {NAMESPACE}", "-f", str(key_path)])
    require(result.returncode == 0,
            f"ssh-keygen failed for {role}: {result.stderr.strip()[:200]}")
    os.chmod(key_path, 0o600)
    public_path = Path(str(key_path) + ".pub")
    require(public_path.is_file(), f"ssh-keygen did not write the public key for {role}")
    os.chmod(public_path, 0o644)


def public_key_line(public_path: Path) -> str:
    text = public_path.read_text(encoding="utf-8").strip()
    require(text.startswith("ssh-ed25519 "), f"unexpected public key format in {public_path}")
    return text


def fingerprint(keygen: str, public_path: Path) -> str:
    result = run([keygen, "-lf", str(public_path)])
    require(result.returncode == 0, f"ssh-keygen -lf failed for {public_path}: {result.stderr.strip()[:200]}")
    return result.stdout.strip()


def public_blob(public_line: str) -> str:
    parts = public_line.split()
    require(len(parts) >= 2, "public key line is malformed")
    return parts[1]


def ensure_outside_bundle(path: Path, bundle: Path | None) -> None:
    if bundle is None:
        return
    resolved = path.resolve()
    require(not resolved.is_relative_to(bundle.resolve()),
            f"{path} must not live inside the evidence bundle {bundle}")


def generate(root: Path, public_dir: Path, signers: Path, *,
             force: bool = False, bundle: Path | None = None) -> dict:
    keygen = ssh_keygen()
    ensure_outside_bundle(public_dir, bundle)
    ensure_outside_bundle(signers, bundle)
    ensure_outside_bundle(root, bundle)

    roles = []
    blobs = {}
    for role in ROLES:
        key_path = root / role / "id_ed25519"
        generate_key(keygen, role, key_path, force=force)
        line = public_key_line(Path(str(key_path) + ".pub"))
        blob = public_blob(line)
        require(blob not in blobs, f"role {role} reuses another role's key")
        blobs[blob] = role
        public_dir.mkdir(parents=True, exist_ok=True)
        public_copy = public_dir / f"{role}.pub"
        public_copy.write_text(line + "\n", encoding="utf-8")
        os.chmod(public_copy, 0o644)
        roles.append({
            "role": role,
            "keyType": "ssh-ed25519",
            "publicKey": line,
            "fingerprint": fingerprint(keygen, public_copy),
        })

    require(len({row["publicKey"].split()[1] for row in roles}) == len(ROLES),
            "the four roles must hold four distinct public keys")

    manifest = {
        "schema": "bandroom.g5-local.key-manifest.v1",
        "protocol": NAMESPACE,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "roleCount": len(roles),
        "distinctKeys": True,
        "singleRootDisclosure": (
            "All four keys were generated on one machine and are held by one "
            "owner (Z-D4). A single compromise forges all four signatures."
        ),
        "roles": roles,
    }
    public_dir.mkdir(parents=True, exist_ok=True)
    (public_dir / "key-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(public_dir / "key-manifest.json", 0o644)

    signers.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{row['role']} ssh-ed25519 {public_blob(row['publicKey'])}" for row in roles]
    signers.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(signers, 0o644)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT,
                        help="private key root (default ~/.bandroom-g5-local/keys)")
    parser.add_argument("--public", type=Path, default=DEFAULT_PUBLIC,
                        help="public key output directory (outside the bundle)")
    parser.add_argument("--signers", type=Path, default=DEFAULT_SIGNERS,
                        help="allowed-signers output file (outside the bundle)")
    parser.add_argument("--bundle", type=Path, default=None,
                        help="optional bundle dir; public keys/signers must stay outside it")
    parser.add_argument("--force", action="store_true",
                        help="overwrite existing keys (rotation invalidates old signatures)")
    args = parser.parse_args(argv)
    try:
        manifest = generate(args.root.resolve(), args.public.resolve(), args.signers.resolve(),
                            force=args.force, bundle=args.bundle.resolve() if args.bundle else None)
    except (Blocked, OSError, subprocess.SubprocessError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2
    for row in manifest["roles"]:
        print(f"{row['role']}: {row['fingerprint']}")
        print(f"  public: {args.public.resolve() / (row['role'] + '.pub')}")
        print(f"  private dir (0700): {args.root.resolve() / row['role']} (key file 0600)")
    print(f"allowed-signers: {args.signers.resolve()} (distribute OUTSIDE the bundle)")
    print("private key material was never printed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())