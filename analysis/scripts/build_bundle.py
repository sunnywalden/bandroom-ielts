#!/usr/bin/env python3
"""Build and hash a private analysis bundle (tar.zst + manifest.json)."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build(version: str, out_dir: Path, root: Path) -> dict:
    if not version or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for char in version):
        raise ValueError("version must contain only letters, digits, dot, underscore or dash")
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = out_dir / "bundle.tar.zst"
    tar_path = out_dir / "bundle.tar"
    with tarfile.open(tar_path, "w") as archive:
        for relative in ("src", "pyproject.toml", "README.md"):
            source = root / relative
            if not source.exists():
                raise FileNotFoundError(source)
            archive.add(source, arcname=relative)
    try:
        subprocess.run(["zstd", "-q", "-f", str(tar_path), "-o", str(bundle)], check=True)
    finally:
        tar_path.unlink(missing_ok=True)
    digest = sha256(bundle)
    manifest = {
        "version": version,
        "bundleSha256": digest,
        "bytes": bundle.stat().st_size,
        "parts": [{"name": "bundle.tar.zst", "sha256": digest, "bytes": bundle.stat().st_size}],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    manifest = build(args.version, args.out_dir, args.root.resolve())
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
