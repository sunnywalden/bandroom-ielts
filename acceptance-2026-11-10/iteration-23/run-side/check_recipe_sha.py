#!/usr/bin/env python3
"""Recompute the frozen v26 recipeSha256 and assert FIXED_CONTRACT.json is consistent.

Canonical form: UTF-8 JSON, keys sorted lexicographically, separators ',' and ':',
no whitespace, no trailing newline, allow_nan=False. SHA-256 over those exact bytes.
This matches the repo's canonical helper used for acoustic stage digests.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def main() -> int:
    contract = json.loads((HERE / "FIXED_CONTRACT.json").read_text(encoding="utf-8"))
    descriptor = contract["recipeDescriptorCanonical"]
    expected = contract["recipeSha256"]
    actual = hashlib.sha256(descriptor.encode()).hexdigest()

    # The stored string must itself be the canonical serialization of the object.
    parsed = json.loads(descriptor)
    reencoded = canonical(parsed).decode()
    print(f"descriptor bytes: {len(descriptor.encode())}")
    print(f"canonical form:   {'yes' if reencoded == descriptor else 'NO'}")
    print(f"recipeSha256:     {actual}")
    print(f"expected:         {expected}")
    ok = reencoded == descriptor and actual == expected
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())