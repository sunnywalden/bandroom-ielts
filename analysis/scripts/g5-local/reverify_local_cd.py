#!/usr/bin/env python3
"""Attempt the G3-local RETAINED clauses on this machine (rev2 section 8.2).

Uses the existing local machinery, unmodified:
  * ``analysis/scripts/g3-fix/qa_v26_hjk_cloud_v2.py`` for canonical decode and
    the cold / prefix+resume acoustic probe phases;
  * the frozen ``Encoder``/probe-head ONNX graphs under ~/.bandroom-acoustic/.

Retained clauses actually computed here
  * C cold == resumed, byte-equal (HARD retained clause);
  * D-local: a SECOND PROCESS recomputes cold and yields the same SHA
    (same-host determinism check, NOT independent-party replication).

Retained clauses that CANNOT be measured by this local probe are reported as
explicit waivers, never as passes:
  * fence monotonic -- needs a server lease log, absent locally;
  * writeback idempotence / lost-replay / old-fence-rejection -- server-side
    behaviours that need the Worker/DB harness, absent locally.

The QA v26 runner requires onnxruntime 1.24.4 exactly. If it is not the active
interpreter, this tool reports the precise blocker and exits 2 instead of
pretending. Point ``BANDROOM_G5_LOCAL_PYTHON`` at a venv that has it (for
example ``~/.bandroom-g5-local/venv/bin/python``).

All paths are env-driven; nothing personal is hard-coded. Nothing is written
into the repository.
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

REQUIRED_ORT = "1.24.4"
DISCLOSURE = (
    "D-local is a same-host SECOND-PROCESS determinism check, not "
    "independent-party replication (rev2 section 8.2)."
)


class Blocked(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Blocked(message)


def sha_file(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def default_acoustic_root() -> Path:
    return Path(os.environ.get("BANDROOM_ACOUSTIC_ROOT", Path.home() / ".bandroom-acoustic"))


def default_python() -> str:
    override = os.environ.get("BANDROOM_G5_LOCAL_PYTHON")
    if override:
        return override
    venv = Path.home() / ".bandroom-g5-local" / "venv" / "bin" / "python"
    return str(venv) if venv.is_file() else sys.executable


def find_source(root: Path, explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit)
        require(path.is_file(), f"source recording not found: {path}")
        return path
    candidates = [
        root / "score-sandbox" / "fixtures" / "hjk.wav",
        root / "corpus" / "suitcase_corpus" / "wav" / "hjk.wav",
    ]
    for path in candidates:
        if path.is_file():
            return path
    for pattern in ("*.wav", "*.aac", "*.m4a"):
        found = sorted(root.rglob(pattern))
        if found:
            return found[0]
    raise Blocked(f"no source recording found under {root}; pass --source")


def run(command: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def ort_version(python: str) -> str | None:
    result = run([python, "-I", "-c", "import onnxruntime; print(onnxruntime.__version__)"], timeout=120)
    return result.stdout.strip() if result.returncode == 0 else None


PREFIX_HELPER = r"""
import importlib.util, json, sys
runner, assets, pcm, work = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("qa_v26", runner)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
import numpy as np
import onnxruntime as ort
samples = np.fromfile(pcm, dtype="<f4")
mod._require(len(samples) > 0, "decoded fixture is empty")
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
encoder = ort.InferenceSession(assets + "/encoder-int8.onnx", sess_options=options,
                               providers=["CPUExecutionProvider"])
pcm_sha = mod.file_sha(pcm)
rows = [mod.window_features(encoder, samples, index) for index in range(8)]
previous, chunks = pcm_sha, []
for index, raw in enumerate(rows):
    chunk = mod.prefix_chunk(index, previous, pcm_sha, raw)
    chunks.append(chunk)
    previous = mod.sha(chunk)
prefix = b"".join(chunks)
mod._require(mod.restore_prefix(prefix, pcm_sha) == rows, "prefix round-trip failed")
with open(work + "/prefix.bin", "wb") as handle:
    handle.write(prefix)
print(json.dumps({"prefixBytes": len(prefix), "prefixSha256": mod.sha(prefix)}))
"""


def build_prefix(python: str, runner: Path, assets: Path, pcm: Path, work: Path) -> dict:
    """Build the 8-window prefix blob with the runner's own functions.

    The v2 runner's ``probe prefix`` branch assumes the head runs over the full
    window count (``frames = windows * 5``) while it only computes 8 windows;
    that generic branch raises a reshape error. We do NOT edit that existing
    artifact. Instead this driver calls the same ``window_features`` /
    ``prefix_chunk`` / ``restore_prefix`` functions over the same 8 windows,
    which is exactly the prefix the resume phase must restore.
    """
    result = run([python, "-I", "-c", PREFIX_HELPER, str(runner), str(assets), str(pcm), str(work)])
    if result.returncode != 0:
        raise Blocked(f"prefix helper failed ({result.returncode}): "
                      f"{(result.stderr or result.stdout).strip()[:400]}")
    return json.loads(result.stdout)


def runner_step(python: str, runner: Path, args: list[str], work: Path) -> dict:
    result = run([python, "-I", str(runner), *args])
    if result.returncode != 0:
        raise Blocked(
            f"runner step {args[0]} failed ({result.returncode}): "
            f"{(result.stderr or result.stdout).strip()[:400]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Blocked(f"runner step {args[0]} returned non-JSON: {error}") from error


def evaluate(root: Path, source: Path | None, assets: Path, work: Path, runner: Path,
             python: str) -> dict:
    require(shutil.which("ffmpeg") is not None, "ffmpeg is required but not on PATH")
    require(shutil.which("ffprobe") is not None, "ffprobe is required but not on PATH")
    require((assets / "encoder-int8.onnx").is_file(), f"missing encoder at {assets}")
    require((assets / "probe-head.onnx").is_file(), f"missing probe head at {assets}")
    require(runner.is_file(), f"missing local runner {runner}")
    source = source or find_source(root, None)

    version = ort_version(python)
    if version != REQUIRED_ORT:
        raise Blocked(
            f"onnxruntime {version!r} is active via {python}, but the QA v26 runner "
            f"requires exactly {REQUIRED_ORT}. Fenced blocker: no local C/D can be "
            f"claimed with a different ORT. Set BANDROOM_G5_LOCAL_PYTHON to a venv "
            f"with onnxruntime=={REQUIRED_ORT}.")

    work = work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    cold_dir = work / "cold"
    resume_dir = work / "resume"
    dlocal_dir = work / "d-local"
    for directory in (cold_dir, resume_dir, dlocal_dir):
        directory.mkdir(parents=True, exist_ok=True)

    decode = runner_step(python, runner, ["decode", "--source", str(source), "--work", str(cold_dir)],
                         cold_dir)
    pcm = cold_dir / "canonical.f32le"
    require(pcm.is_file(), "decode did not produce canonical.f32le")

    build_prefix(python, runner, assets, pcm, cold_dir)
    require((cold_dir / "prefix.bin").is_file(), "prefix helper did not write prefix.bin")
    shutil.copyfile(cold_dir / "prefix.bin", resume_dir / "prefix.bin")

    cold = runner_step(python, runner,
                       ["probe", "cold", str(assets), str(cold_dir), str(pcm)], cold_dir)
    shutil.copyfile(cold_dir / "canonical.f32le", resume_dir / "canonical.f32le")
    resumed = runner_step(python, runner,
                          ["probe", "resume", str(assets), str(resume_dir), str(pcm)], resume_dir)
    # D-local: a SECOND, separate process recomputes cold from scratch.
    runner_step(python, runner,
                ["probe", "cold", str(assets), str(dlocal_dir), str(pcm)], dlocal_dir)

    cold_bytes = (cold_dir / "cold-output.f32le").read_bytes()
    resumed_bytes = (resume_dir / "resumed-output.f32le").read_bytes()
    dlocal_bytes = (dlocal_dir / "cold-output.f32le").read_bytes()
    cold_sha = sha256(cold_bytes).hexdigest()
    resumed_sha = sha256(resumed_bytes).hexdigest()
    dlocal_sha = sha256(dlocal_bytes).hexdigest()

    cold_equals_resumed = cold_bytes == resumed_bytes
    dlocal_same = cold_sha == dlocal_sha

    export_input = work / "export-input"
    export_input.mkdir(parents=True, exist_ok=True)
    (export_input / "cold-output.bin").write_bytes(cold_bytes)
    (export_input / "resumed-output.bin").write_bytes(resumed_bytes)
    (export_input / "d-local-output.bin").write_bytes(dlocal_bytes)

    result = {
        "schema": "bandroom.g5-local.cd-reverify.v1",
        "status": "pass" if cold_equals_resumed and dlocal_same else "fail",
        "identityScope": "local-attestation",
        "analysisVersion": "qa-diagnostic-v26",
        "environmentId": "local-macos-single-host",
        "sourceProvenance": {
            "source": str(source),
            "sourceSha256": sha_file(source),
            "sourceBytes": source.stat().st_size,
            "canonicalPcm": str(pcm),
            "canonicalPcmSha256": sha_file(pcm),
            "canonicalSampleCount": decode.get("canonicalSampleCount"),
            "windows": cold.get("windows"),
            "onnxruntime": version,
            "encoderSha256": sha_file(assets / "encoder-int8.onnx"),
            "probeHeadSha256": sha_file(assets / "probe-head.onnx"),
            "runnerSha256": sha_file(runner),
            "runner": str(runner),
        },
        "recording": {
            "recordingSha256": sha_file(pcm),
            "inputBytes": pcm.stat().st_size,
        },
        "coldResumed": {
            "coldOutputSha256": cold_sha,
            "resumedOutputSha256": resumed_sha,
            "coldEqualsResumed": cold_equals_resumed,
            "outputBytes": len(cold_bytes),
            "resumedOnlyWindows": resumed.get("computedWindows"),
        },
        "dLocal": {
            "coldOutputSha256": dlocal_sha,
            "sameShaAsResumed": dlocal_same,
            "independentProcess": True,
            "disclosure": DISCLOSURE,
        },
        "retainedClauses": {
            "coldEqualsResumed": {"status": "pass" if cold_equals_resumed else "fail",
                                  "detail": f"{len(cold_bytes)} bytes"},
            "dLocalSameSha": {"status": "pass" if dlocal_same else "fail", "detail": DISCLOSURE},
            "fenceMonotonic": {
                "status": "waived",
                "reason": "local probe has no server lease/fence log; not measurable without the Worker/DB harness",
            },
            "writebackIdempotent": {
                "status": "waived",
                "reason": "server-side writeback; not measurable without the Worker/DB harness",
            },
            "writebackLostReplay": {
                "status": "waived",
                "reason": "server-side replay; not measurable without the Worker/DB harness",
            },
            "writebackOldFenceReject": {
                "status": "waived",
                "reason": "server-side fence rejection; not measurable without the Worker/DB harness",
            },
        },
        "qaVerifierNote": (
            "verify_official_run_v26_qa.py consumes full stage reports "
            "(bandroom.qa.acoustic-output.v1 with feedback/markers/anchors); the local "
            "probe emits probe JSON only, so the byte-level retained clauses are "
            "verified directly from the runner outputs. The QA verifier was not run "
            "against fabricated stage reports."
        ),
        "localRunForExporter": str(export_input / "local-run.json"),
    }

    run_input = {
        "schemaVersion": 1,
        "analysisVersion": result["analysisVersion"],
        "environmentId": result["environmentId"],
        "recording": result["recording"],
        "execution": {
            "mode": "local-runner",
            "scheduledWakeCount": None,
            "spanSeconds": None,
            "approvalPrompts": 0,
            "failClosed": True,
        },
        "coldResumed": result["coldResumed"],
        "dLocal": result["dLocal"],
        "sourceProvenance": result["sourceProvenance"],
        "waivers": [
            {"clause": "G3-fence-monotonic", "reason": "no server lease/fence log locally"},
            {"clause": "G3-writeback-*", "reason": "server-side writeback not measurable locally"},
            {"clause": "G3-scheduled-wakes", "reason": "no 24h local scheduled window yet"},
        ],
    }
    (export_input / "local-run.json").write_text(
        json.dumps(run_input, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--acoustic-root", type=Path, default=default_acoustic_root())
    parser.add_argument("--source", default=None, help="recording to probe")
    parser.add_argument("--assets", type=Path, default=None,
                        help="directory with encoder-int8.onnx / probe-head.onnx")
    parser.add_argument("--work", type=Path,
                        default=Path.home() / ".bandroom-g5-local" / "work")
    parser.add_argument("--runner", type=Path, default=None,
                        help="qa_v26_hjk_cloud_v2.py path")
    parser.add_argument("--python", default=default_python(),
                        help="interpreter carrying onnxruntime==1.24.4")
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args(argv)

    root = args.acoustic_root.resolve()
    assets = args.assets or root / "rescued" / "onnx-graphs"
    runner = args.runner or (Path(__file__).resolve().parents[1] / "g3-fix" / "qa_v26_hjk_cloud_v2.py")
    json_out = args.json_out or Path.home() / ".bandroom-g5-local" / "local-cd-result.json"
    try:
        result = evaluate(root, Path(args.source) if args.source else None, assets,
                          args.work, runner, args.python)
    except (Blocked, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        record = {"schema": "bandroom.g5-local.cd-reverify.v1", "status": "blocked",
                  "blocker": str(error), "disclosure": DISCLOSURE}
        json_out.parent.mkdir(parents=True, exist_ok=True)
        json_out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"BLOCKED: {error}", file=sys.stderr)
        print(f"wrote {json_out}", file=sys.stderr)
        return 2

    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": result["status"],
        "coldOutputSha256": result["coldResumed"]["coldOutputSha256"],
        "resumedOutputSha256": result["coldResumed"]["resumedOutputSha256"],
        "dLocalOutputSha256": result["dLocal"]["coldOutputSha256"],
        "coldEqualsResumed": result["coldResumed"]["coldEqualsResumed"],
        "dLocalSameSha": result["dLocal"]["sameShaAsResumed"],
    }, indent=2))
    print(f"wrote {json_out}")
    print(f"local-run.json for exporter: {result['localRunForExporter']}")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())