"""Run and resume the DistilHuBERT development acoustic stage on a private disk."""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import fcntl
from hashlib import sha256
import json
from pathlib import Path
import platform
import re
import struct
import sys
import time

from .checkpoint import read_checkpoint, write_atomically
from .decode import DecodedAudio

FORMAT = "bandroom-acoustic-features-v1"
TRANSFER_FORMAT = "bandroom-acoustic-chunk-v1"
FRAME_SAMPLES = 320
RECEPTIVE_SAMPLES = 400
FRAMES_PER_WINDOW = 800
CONTEXT_FRAMES = 100
PASS_OFFSETS = (0, 400)
FEATURES = 768
PHONES = 49
MAX_MANIFEST = 256 * 1024
MAX_TRANSFER_HEADER = 4096
MAX_GRAPH = 300_000_000
DIGEST = re.compile(r"[a-f0-9]{64}")
IDENTIFIER = re.compile(r"[A-Za-z0-9._-]{1,160}")


@dataclass(frozen=True)
class Window:
    offset: int
    start_frame: int
    end_frame: int
    left_context: int
    right_context: int

    @property
    def bytes(self) -> int:
        return (self.end_frame - self.start_frame) * FEATURES * 4


def windows(sample_count: int) -> Iterator[Window]:
    total = (sample_count - RECEPTIVE_SAMPLES) // FRAME_SAMPLES + 1
    if total < 1:
        raise ValueError("the acoustic stage requires at least 25 ms of canonical PCM")
    for offset in PASS_OFFSETS:
        for first in range(offset - FRAMES_PER_WINDOW if offset else 0, total, FRAMES_PER_WINDOW):
            start = max(0, first)
            end = min(total, first + FRAMES_PER_WINDOW)
            yield Window(offset, start, end, max(0, start - CONTEXT_FRAMES), min(total, end + CONTEXT_FRAMES))


def _json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _read(path: Path, limit: int) -> bytes:
    with path.open("rb") as source:
        return source.read(limit + 1)


def encode_chunk(identity: dict, index: int, previous: str, raw: bytes) -> bytes:
    header = _json({
        "format": TRANSFER_FORMAT, "chunkIndex": index, "previousSha256": previous,
        "decodeSha256": identity["decodeSha256"], "bundleSha256": identity["bundleSha256"],
        "configSha256": identity["configSha256"], "featuresSha256": sha256(raw).hexdigest(),
    })
    return struct.pack(">I", len(header)) + header + raw


def read_chunk(path: Path, digest: str, identity: dict, index: int, previous: str, size: int) -> bytes:
    limit = 4 + MAX_TRANSFER_HEADER + size
    value = _read(path, limit)
    if not 4 + size < len(value) <= limit or sha256(value).hexdigest() != digest:
        raise ValueError(f"acoustic transfer chunk {index} has an invalid length or digest")
    header_length = struct.unpack_from(">I", value)[0]
    raw = value[4 + header_length:]
    if len(raw) != size or value != encode_chunk(identity, index, previous, raw):
        raise ValueError(f"acoustic transfer chunk {index} has an invalid identity or predecessor")
    return raw


class AcousticStore:
    def __init__(self, directory: Path, identity: dict, plan: list[Window]):
        self.directory = directory
        self.index = directory / "acoustic.json"
        self.header = {"format": FORMAT, "identity": identity, "plan": [asdict(window) for window in plan]}
        self.plan = plan

    @contextmanager
    def lock(self) -> Iterator[None]:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (self.directory / "acoustic.lock").open("ab") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def load(self) -> tuple[list[dict], list[bytes], int]:
        if not self.index.exists():
            return [], [], 0
        raw = _read(self.index, MAX_MANIFEST)
        if len(raw) > MAX_MANIFEST:
            raise ValueError("acoustic index exceeds its size limit")
        manifest = json.loads(raw)
        if (not isinstance(manifest, dict) or set(manifest) != {*self.header, "chunks", "nextChunk"}
                or any(manifest[key] != expected for key, expected in self.header.items())):
            raise ValueError("acoustic index identity or plan differs from this execution")
        chunks = manifest["chunks"]
        if (not isinstance(chunks, list) or type(manifest["nextChunk"]) is not int
                or manifest["nextChunk"] != len(chunks) or len(chunks) > len(self.plan)):
            raise ValueError("acoustic index contains an invalid prefix")
        rows = []
        for index, chunk in enumerate(chunks):
            size = self.plan[index].bytes
            if (not isinstance(chunk, dict) or set(chunk) != {"bytes", "sha256"}
                    or type(chunk["bytes"]) is not int or chunk["bytes"] != size
                    or not isinstance(chunk["sha256"], str) or not DIGEST.fullmatch(chunk["sha256"])):
                raise ValueError("acoustic index contains invalid chunk metadata")
            try:
                value = _read(self.directory / (chunk["sha256"] + ".f32"), size)
            except FileNotFoundError:
                break
            if len(value) != size or sha256(value).hexdigest() != chunk["sha256"]:
                break
            rows.append(value)
        return chunks[:len(rows)], rows, len(chunks) - len(rows)

    def save(self, chunks: list[dict], value: bytes) -> dict:
        if len(value) != self.plan[len(chunks)].bytes:
            raise ValueError("acoustic window has an invalid feature byte count")
        digest = sha256(value).hexdigest()
        write_atomically(self.directory / (digest + ".f32"), value)
        chunk = {"sha256": digest, "bytes": len(value)}
        write_atomically(self.index, self.manifest([*chunks, chunk]))
        return chunk

    def manifest(self, chunks: list[dict]) -> bytes:
        return _json({**self.header, "chunks": chunks, "nextChunk": len(chunks)})

    def restore(self, sources: list[tuple[str, Path]], chunks: list[dict], rows: list[bytes]) -> int:
        if len(sources) > len(self.plan):
            raise ValueError("acoustic transfer prefix exceeds the window count")
        previous = self.header["identity"]["decodeSha256"]
        restored = 0
        for index, (digest, path) in enumerate(sources):
            raw = read_chunk(path, digest, self.header["identity"], index, previous, self.plan[index].bytes)
            if index == len(chunks):
                chunks.append(self.save(chunks, raw))
                rows.append(raw)
                restored += 1
            elif raw != rows[index]:
                raise ValueError(f"acoustic transfer chunk {index} conflicts with the local checkpoint")
            previous = digest
        return restored

    def export(self, directory: Path, rows: list[bytes]) -> list[str]:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        previous = self.header["identity"]["decodeSha256"]
        digests = []
        for index, raw in enumerate(rows):
            value = encode_chunk(self.header["identity"], index, previous, raw)
            write_atomically(directory / f"{index:02}.bin", value)
            previous = sha256(value).hexdigest()
            digests.append(previous)
        return digests


def _graph(path: Path, expected: str) -> bytes:
    value = _read(path, MAX_GRAPH)
    if not value or len(value) > MAX_GRAPH or sha256(value).hexdigest() != expected:
        raise ValueError(f"graph digest or byte count differs from the pinned {path.name}")
    return value


def run(decoded: DecodedAudio, args: argparse.Namespace) -> dict:
    import numpy as np
    import onnxruntime as ort

    plan = list(windows(decoded.sample_count))
    config = {
        "analysisVersion": args.analysis_version, "format": FORMAT,
        "encoderSha256": args.encoder_sha256, "headSha256": args.head_sha256,
        "frameSamples": FRAME_SAMPLES, "receptiveSamples": RECEPTIVE_SAMPLES,
        "windowFrames": FRAMES_PER_WINDOW, "contextFrames": CONTEXT_FRAMES, "offsets": PASS_OFFSETS,
        "featureCount": FEATURES, "phoneCount": PHONES,
        "runtime": {"onnxruntime": ort.__version__, "numpy": np.__version__, "threads": args.threads,
                    "provider": "CPUExecutionProvider", "machine": platform.machine(), "system": platform.system()},
    }
    identity = {
        "environment": args.environment, "taskId": args.task, "attemptId": args.attempt, "revision": args.revision,
        "inputSha256": decoded.input_sha256, "inputBytes": decoded.input_bytes,
        "decodeSha256": args.checkpoint_sha256, "bundleSha256": args.bundle_sha256,
        "configSha256": sha256(_json(config)).hexdigest(),
    }
    store = AcousticStore(args.directory, identity, plan)
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1

    def session(path: Path, digest: str) -> ort.InferenceSession:
        return ort.InferenceSession(_graph(path, digest), sess_options=options, providers=["CPUExecutionProvider"])

    with store.lock():
        chunks, rows, invalidated = store.load()
        restored = store.restore(args.restore_chunk, chunks, rows) if args.restore_chunk else 0
        reused = len(chunks)
        stop = len(plan) if args.max_new_chunks is None else min(len(plan), reused + args.max_new_chunks)
        if stop > reused:
            encoder = session(args.encoder, args.encoder_sha256)
            for window in plan[reused:stop]:
                start = window.left_context * FRAME_SAMPLES
                end = (window.right_context - 1) * FRAME_SAMPLES + RECEPTIVE_SAMPLES
                pcm = np.asarray(decoded.samples[start:end], dtype=np.float32) / 32768.0
                features = encoder.run(["features"], {"samples": pcm[None]})[0]
                expected = (1, window.right_context - window.left_context, FEATURES)
                if features.shape != expected or features.dtype != np.float32 or not np.isfinite(features).all():
                    raise ValueError("encoder output has an invalid feature shape or value")
                value = features[0, window.start_frame - window.left_context:window.end_frame - window.left_context]
                raw = value.astype("<f4", copy=False).tobytes()
                chunks.append(store.save(chunks, raw))
                rows.append(raw)
            del encoder
        transfers = store.export(args.export_directory, rows) if args.export_directory else []
        logits = []
        if stop == len(plan):
            head = session(args.head, args.head_sha256)
            for offset in PASS_OFFSETS:
                features = np.frombuffer(b"".join(raw for window, raw in zip(plan, rows) if window.offset == offset),
                                         dtype="<f4").reshape(-1, FEATURES)
                frame, ctc, boundary = head.run(["frame", "ctc", "boundary"], {"features": features})
                if (frame.shape != (len(features), PHONES) or ctc.shape != (len(features), PHONES + 1)
                        or boundary.shape != (len(features),)
                        or any(row.dtype != np.float32 or not np.isfinite(row).all() for row in (frame, ctc, boundary))):
                    raise ValueError("phone head output has an invalid shape or value")
                logits.append({"offset": offset, "frames": len(features), **{
                    name + "Sha256": sha256(row.astype("<f4", copy=False).tobytes()).hexdigest()
                    for name, row in (("frame", frame), ("ctc", ctc), ("boundary", boundary))
                }})
        return {
            "stage": "acoustic", "state": "features_complete" if logits else "paused",
            "identity": identity, "identitySha256": sha256(_json(identity)).hexdigest(),
            "checkpointSha256": sha256(store.manifest(chunks)).hexdigest(),
            "nextChunk": stop, "totalChunks": len(plan), "reusedChunks": reused,
            "newChunks": stop - reused, "invalidatedChunks": invalidated, "restoredChunks": restored,
            "transferSha256": transfers, "logits": logits,
        }


def _transfer_source(value: str) -> tuple[str, Path]:
    digest, _, path = value.partition("=")
    if not DIGEST.fullmatch(digest) or not path:
        raise argparse.ArgumentTypeError("use SHA256=FILE for each acoustic transfer chunk")
    return digest, Path(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("checkpoint", "encoder", "head", "directory"):
        parser.add_argument("--" + argument, type=Path, required=True)
    for argument in ("input", "checkpoint", "encoder", "head", "bundle"):
        parser.add_argument(f"--{argument}-sha256", required=True)
    for argument in ("environment", "task", "attempt", "analysis-version"):
        parser.add_argument("--" + argument, required=True)
    parser.add_argument("--revision", type=int, required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-new-chunks", type=int)
    parser.add_argument("--restore-chunk", type=_transfer_source, action="append", default=[])
    parser.add_argument("--export-directory", type=Path)
    args = parser.parse_args(argv)
    if any(not DIGEST.fullmatch(getattr(args, key + "_sha256"))
           for key in ("input", "checkpoint", "encoder", "head", "bundle")):
        parser.error("SHA-256 arguments require 64 lowercase hexadecimal characters")
    if (any(not IDENTIFIER.fullmatch(getattr(args, key)) for key in ("environment", "task", "attempt"))
            or not 1 <= args.revision <= 2**53 - 1 or not 1 <= args.threads <= 16
            or (args.max_new_chunks is not None and args.max_new_chunks < 1)):
        parser.error("invalid execution identity or chunk budget")
    started = time.monotonic()
    try:
        decoded = read_checkpoint(args.checkpoint, input_sha256=args.input_sha256,
                                  artifact_sha256=args.checkpoint_sha256, analysis_version=args.analysis_version)
        receipt = run(decoded, args)
    except (ImportError, OSError, ValueError) as exc:
        print(f"acoustic stage failed: {exc}", file=sys.stderr)
        return 2
    receipt["wallSeconds"] = round(time.monotonic() - started, 3)
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
