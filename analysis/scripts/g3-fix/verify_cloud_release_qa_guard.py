#!/usr/bin/env python3
"""Additive QA/formal separation guard for the FORMAL verify_bundle.

The frozen formal verifier ``analysis/scripts/verify_cloud_release.py``
(sha256 64e2b8a6..., see STREAM2_REPORT.md) is NOT edited. This module wraps
its ``verify_bundle`` entry point so that a QA-scoped manifest can never be
accepted as formal G5 evidence.

Hard separation rule
--------------------
The formal ``verify_bundle`` REJECTS a manifest when any of these is true:

* ``protocol`` is ``bandroom-d2-cloud-recovery-v1-qa-diagnostic``;
* the ``qaScoped`` key is present at all (any value, including false);
* ``identityScope`` is ``qa-diagnostic``.

It rejects before signature verification, so a QA signature can never be
mistaken for a formal signature. A malformed or missing manifest is left for
the original verifier to report; the guard only removes the QA case.

Integration (additive, no source mutation)
------------------------------------------
Option A, in-process, before the formal CLI runs::

    import verify_cloud_release_qa_guard as guard
    guard.install()                # monkeypatches verify_cloud_release.verify_bundle
    # then call verify_cloud_release.main() / verify_bundle(...) as usual

Option B, explicit wrapper around an existing callable::

    guarded = guard.guard_verify_bundle(verify_cloud_release.verify_bundle)
    guarded(bundle, trusted_signers, legacy_dir, repo, recordings, phase)

Option C, standalone preflight (CI or a shell wrapper)::

    python3 verify_cloud_release_qa_guard.py --check-manifest BUNDLE/manifest.json
    # exit 1 with QAREJECT when the manifest is QA-scoped, 0 otherwise

Because the guard is a module, the frozen verifier bytes and its re-freeze SHA
stay unchanged. Re-freezing the formal verifier is still required if the guard
is folded into it later; that is an owner/review decision, not done here.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

QA_NAMESPACE = "bandroom-d2-cloud-recovery-v1-qa-diagnostic"
QA_IDENTITY_SCOPE = "qa-diagnostic"


class QaManifestRejected(ValueError):
    """Raised when a QA-scoped manifest reaches the formal verifier."""


def qa_manifest_reason(manifest) -> str | None:
    """Return a rejection reason when the document is QA-scoped, else None."""
    if not isinstance(manifest, dict):
        return None
    if manifest.get("protocol") == QA_NAMESPACE:
        return f"protocol is the QA namespace {QA_NAMESPACE}"
    if "qaScoped" in manifest:
        return f"manifest carries qaScoped={manifest.get('qaScoped')!r}; QA evidence is not formal G5"
    if manifest.get("identityScope") == QA_IDENTITY_SCOPE:
        return "manifest carries identityScope='qa-diagnostic'"
    return None


def reject_qa_manifest(manifest) -> None:
    reason = qa_manifest_reason(manifest)
    if reason:
        raise QaManifestRejected(
            "QA-scoped evidence rejected by the formal verifier: " + reason)


def check_manifest_path(path: Path) -> None:
    """Preflight a manifest file; let the original verifier handle bad JSON."""
    try:
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    reject_qa_manifest(manifest)


def guard_verify_bundle(original):
    """Wrap a verify_bundle callable; reject QA manifests before anything else."""
    def guarded_verify_bundle(bundle, *args, **kwargs):
        check_manifest_path(Path(bundle) / "manifest.json")
        return original(bundle, *args, **kwargs)

    guarded_verify_bundle.__name__ = getattr(original, "__name__", "verify_bundle")
    guarded_verify_bundle.__doc__ = getattr(original, "__doc__", None)
    guarded_verify_bundle._qa_guard = True
    guarded_verify_bundle._original = original
    return guarded_verify_bundle


def install(module=None):
    """Monkeypatch ``module.verify_bundle`` (default: verify_cloud_release).

    Idempotent: calling install twice does not stack wrappers. Returns the
    guarded callable. The original module file is not touched.
    """
    if module is None:
        import verify_cloud_release as module  # local import keeps tooling light
    current = module.verify_bundle
    if getattr(current, "_qa_guard", False):
        return current
    module.verify_bundle = guard_verify_bundle(current)
    return module.verify_bundle


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Preflight a manifest for the formal verifier and reject QA-scoped evidence.")
    parser.add_argument("--check-manifest", type=Path, required=True)
    args = parser.parse_args(argv if argv is not None else None)
    try:
        manifest = json.loads(args.check_manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        parser.exit(2, f"UNREADABLE: {error}\n")
    try:
        reject_qa_manifest(manifest)
    except QaManifestRejected as error:
        print(f"QAREJECT: {error}")
        return 1
    print("OK: manifest is not QA-scoped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())