#!/usr/bin/env python3
"""Build and run a private Linux x86-64 acoustic-stage bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from zipfile import BadZipFile, ZipFile, ZipInfo


TARGET = {"system": "Linux", "machine": "x86_64", "python": "3.12"}
GRAPHS = {
    "encoder-int8.onnx": "913f30b95735bbf2e7d80dc93066e2730dc02bd0d19fb4a6b7cfefab657ed07c",
    "probe-head.onnx": "813c832bebffb68087be08544a1be100c1e73dda6f431d7a4731084e22430370",
}
REQUIREMENTS = "requirements-cloud-x86_64.txt"
MANIFEST = "cloud-stage.json"


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def locked_wheels(path: Path) -> dict[str, str]:
    wheels = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        wheel, digest = line.split(" --hash=sha256:")
        if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.whl", wheel) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("invalid cloud wheel lock")
        if wheel in wheels:
            raise ValueError("duplicate cloud wheel")
        wheels[wheel] = digest
    if not wheels:
        raise ValueError("empty cloud wheel lock")
    return wheels


def zip_member(archive: ZipFile, name: str, source: Path) -> None:
    member = ZipInfo(name)
    with source.open("rb") as src, archive.open(member, "w") as dst:
        shutil.copyfileobj(src, dst)


def build(args: argparse.Namespace) -> dict:
    root = Path(__file__).resolve().parents[1]
    lock = root / REQUIREMENTS
    wheels = locked_wheels(lock)
    files = {REQUIREMENTS: lock}
    for filename, digest in GRAPHS.items():
        path = args.graphs / filename
        if sha256(path) != digest:
            raise ValueError(f"unexpected graph SHA-256 for {filename}")
        files[f"graphs/{filename}"] = path
    for filename, digest in wheels.items():
        path = args.wheels / filename
        if sha256(path) != digest:
            raise ValueError(f"unexpected wheel SHA-256 for {filename}")
        files[f"wheels/{filename}"] = path
    for path in sorted((root / "src/bandroom_acoustic").glob("*.py")):
        files[path.relative_to(root).as_posix()] = path
    manifest = {
        "protocol": "bandroom-cloud-stage-v1",
        "target": TARGET,
        "files": {name: sha256(path) for name, path in files.items()},
    }
    with tempfile.TemporaryDirectory(dir=args.bundle.parent) as temporary:
        output = Path(temporary) / args.bundle.name
        with ZipFile(output, "w") as archive:
            archive.writestr(ZipInfo(MANIFEST), json.dumps(manifest, sort_keys=True))
            for name in sorted(files):
                zip_member(archive, name, files[name])
        digest = sha256(output)
        output.replace(args.bundle)
    return {"bundleSha256": digest, "bytes": args.bundle.stat().st_size, **manifest}


def unpack(bundle: Path, expected_sha: str, directory: Path) -> None:
    with bundle.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != expected_sha:
            raise ValueError("cloud stage bundle SHA-256 mismatch")
        handle.seek(0)
        with ZipFile(handle) as archive:
            manifest = json.loads(archive.read(MANIFEST))
            files = manifest["files"]
            names = archive.namelist()
            if (manifest.get("protocol") != "bandroom-cloud-stage-v1" or manifest.get("target") != TARGET
                    or len(names) != len(files) + 1 or set(names) != {*files, MANIFEST}):
                raise ValueError("cloud stage manifest does not match the archive")
            for name, digest in files.items():
                if not re.fullmatch(r"(?:src/bandroom_acoustic/[a-z_]+\.py|graphs/[a-z0-9-]+\.onnx"
                                    r"|wheels/[A-Za-z0-9_.+-]+\.whl|requirements-cloud-x86_64\.txt)", name):
                    raise ValueError("unexpected cloud stage archive path")
                target = directory / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                if sha256(target) != digest:
                    raise ValueError(f"cloud stage member SHA-256 mismatch for {name}")
    expected = {f"graphs/{name}": digest for name, digest in GRAPHS.items()}
    expected.update({f"wheels/{name}": digest for name, digest in locked_wheels(directory / REQUIREMENTS).items()})
    if expected != {name: digest for name, digest in files.items() if name.startswith(("graphs/", "wheels/"))}:
        raise ValueError("cloud stage graph or wheel set differs from the lock")


def stage_arguments(args: argparse.Namespace, directory: Path) -> list[str]:
    common = ["--input-sha256", args.input_sha256, "--analysis-version", args.analysis_version]
    if args.command == "decode":
        ffmpeg = shutil.which(args.ffmpeg)
        if ffmpeg is None:
            raise ValueError("ffmpeg is unavailable in this runner")
        return [*common, "--audio", str(args.audio), "--input-bytes", str(args.input_bytes),
                "--decode-only", "--save-checkpoint", str(args.save_checkpoint), "--ffmpeg", ffmpeg]
    command = [*common, "--checkpoint", str(args.checkpoint), "--checkpoint-sha256", args.checkpoint_sha256,
               "--directory", str(args.directory), "--bundle-sha256", args.bundle_sha256,
               "--encoder", str(directory / "graphs/encoder-int8.onnx"),
               "--encoder-sha256", GRAPHS["encoder-int8.onnx"],
               "--head", str(directory / "graphs/probe-head.onnx"),
               "--head-sha256", GRAPHS["probe-head.onnx"], "--threads", str(args.threads),
               "--environment", args.environment, "--task", args.task, "--attempt", args.attempt,
               "--revision", str(args.revision)]
    if args.max_new_chunks is not None:
        command.extend(("--max-new-chunks", str(args.max_new_chunks)))
    if args.export_directory is not None:
        command.extend(("--export-directory", str(args.export_directory)))
    for chunk in args.restore_chunk:
        command.extend(("--restore-chunk", chunk))
    return command


def execute(args: argparse.Namespace) -> int:
    current = {"system": platform.system(), "machine": platform.machine(),
               "python": f"{sys.version_info.major}.{sys.version_info.minor}"}
    if current != TARGET:
        raise ValueError(f"expected Linux x86-64 CPython 3.12, found {current}")
    with tempfile.TemporaryDirectory(prefix="bandroom-cloud-stage-") as temporary:
        directory = Path(temporary)
        unpack(args.bundle, args.bundle_sha256, directory)
        module = "bandroom_acoustic.cli"
        dependencies = directory / "deps"
        if args.command == "acoustic":
            module = "bandroom_acoustic.acoustic_stage"
            subprocess.run([sys.executable, "-I", "-m", "pip", "--isolated", "install",
                            "--no-index", "--no-deps", "--require-hashes", "--no-compile",
                            "--disable-pip-version-check", "--target", str(dependencies),
                            "-r", f"../{REQUIREMENTS}"], cwd=directory / "wheels", stdout=sys.stderr, check=True)
        entry = ("import runpy, sys; sys.path[0:0] = sys.argv[1:3]; "
                 "sys.argv = sys.argv[3:]; runpy.run_module(sys.argv[0], run_name='__main__')")
        command = [sys.executable, "-I", "-S", "-c", entry, str(directory / "src"), str(dependencies), module,
                   *stage_arguments(args, directory)]
        return subprocess.run(command, check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    bundle = commands.add_parser("build")
    for option in ("bundle", "graphs", "wheels"):
        bundle.add_argument(f"--{option}", type=Path, required=True)
    decode = commands.add_parser("decode")
    acoustic = commands.add_parser("acoustic")
    for stage in (decode, acoustic):
        stage.add_argument("--bundle", type=Path, required=True)
        for option in ("bundle-sha256", "input-sha256", "analysis-version"):
            stage.add_argument(f"--{option}", required=True)
    decode.add_argument("--audio", type=Path, required=True)
    decode.add_argument("--input-bytes", type=int, required=True)
    decode.add_argument("--save-checkpoint", type=Path, required=True)
    decode.add_argument("--ffmpeg", default="ffmpeg")
    for option in ("checkpoint", "directory"):
        acoustic.add_argument(f"--{option}", type=Path, required=True)
    for option in ("checkpoint-sha256", "environment", "task", "attempt"):
        acoustic.add_argument(f"--{option}", required=True)
    acoustic.add_argument("--revision", type=int, required=True)
    acoustic.add_argument("--threads", type=int, default=4)
    acoustic.add_argument("--max-new-chunks", type=int)
    acoustic.add_argument("--export-directory", type=Path)
    acoustic.add_argument("--restore-chunk", action="append", default=[])
    args = parser.parse_args()
    try:
        if args.command == "build":
            print(json.dumps(build(args), sort_keys=True))
            return 0
        if not re.fullmatch(r"[a-f0-9]{64}", args.input_sha256):
            parser.error("--input-sha256 requires 64 lowercase hexadecimal characters")
        return execute(args)
    except (OSError, ValueError, BadZipFile, KeyError, subprocess.CalledProcessError) as exc:
        print(f"cloud stage failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
