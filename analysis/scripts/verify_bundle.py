#!/usr/bin/env python3
"""Verify a private bundle against its manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"manifest invalid: {exc}", file=sys.stderr)
        return 2
    if not isinstance(manifest, dict) or not isinstance(manifest.get("bundleSha256"), str):
        print("manifest has no bundleSha256", file=sys.stderr)
        return 2
    actual = sha256(args.bundle)
    size = args.bundle.stat().st_size
    if actual != manifest["bundleSha256"] or size != manifest.get("bytes"):
        print(f"bundle mismatch: sha={actual} bytes={size}", file=sys.stderr)
        return 1
    print(json.dumps({"verified": True, "sha256": actual, "bytes": size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
