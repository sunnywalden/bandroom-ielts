"""Versioned decoded audio and media coordinates shared across Work runs."""

from __future__ import annotations

from array import array
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import tempfile

from .decode import DecodeError, DecodedAudio, MAX_AUDIO, MAX_SAMPLES, TARGET_RATE

FORMAT = "bandroom-decode-v1"
MAX_MANIFEST = 4096
MAX_CHECKPOINT = 4 + MAX_MANIFEST + MAX_AUDIO
MEDIA_TIME = {"originMs": 0, "samplesPerSecond": TARGET_RATE}
MANIFEST_FIELDS = {
    "format", "analysisVersion", "inputSha256", "inputBytes", "container", "codec",
    "sourceRateHz", "sourceChannels", "containerDurationMs", "primingMs", "pcm", "mediaTime",
}
PCM_FIELDS = {"encoding", "rateHz", "channels", "sampleCount", "sha256"}


def write_atomically(path: Path, value: bytes) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def encode_checkpoint(decoded: DecodedAudio, analysis_version: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", analysis_version):
        raise DecodeError("invalid checkpoint analysis version")
    if (decoded.sample_rate != TARGET_RATE or not 0 < decoded.input_bytes <= MAX_AUDIO
            or not 0 < decoded.sample_count == len(decoded.samples) <= MAX_SAMPLES):
        raise DecodeError("decoded audio exceeds the checkpoint bounds")
    samples = array("h", decoded.samples)
    if sys.byteorder != "little":
        samples.byteswap()
    pcm = samples.tobytes()
    manifest = json.dumps({
        "format": FORMAT,
        "analysisVersion": analysis_version,
        "inputSha256": decoded.input_sha256,
        "inputBytes": decoded.input_bytes,
        "container": decoded.container,
        "codec": decoded.codec,
        "sourceRateHz": decoded.source_rate,
        "sourceChannels": decoded.source_channels,
        "containerDurationMs": decoded.container_duration_ms,
        "primingMs": decoded.priming_ms,
        "pcm": {
            "encoding": "s16le", "rateHz": TARGET_RATE, "channels": 1,
            "sampleCount": decoded.sample_count, "sha256": sha256(pcm).hexdigest(),
        },
        "mediaTime": MEDIA_TIME,
    }, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(manifest) > MAX_MANIFEST:
        raise DecodeError("checkpoint manifest exceeds its size limit")
    return struct.pack(">I", len(manifest)) + manifest + pcm


def _count(value: object, maximum: int = 2**53 - 1) -> bool:
    return type(value) is int and 0 < value <= maximum


def _duration(value: object) -> bool:
    return value is None or (type(value) in (int, float) and 0 <= value < math.inf)


def read_checkpoint(path: Path, *, input_sha256: str, artifact_sha256: str, analysis_version: str) -> DecodedAudio:
    if not re.fullmatch(r"[0-9a-f]{64}", input_sha256) or not re.fullmatch(r"[0-9a-f]{64}", artifact_sha256):
        raise DecodeError("checkpoint requires the expected input and artifact SHA-256")
    with path.open("rb") as handle:
        value = handle.read(MAX_CHECKPOINT + 1)
    if len(value) < 7 or len(value) > MAX_CHECKPOINT or sha256(value).hexdigest() != artifact_sha256:
        raise DecodeError("checkpoint artifact digest or length does not match")
    length = struct.unpack_from(">I", value)[0]
    if not 0 < length <= MAX_MANIFEST or 4 + length >= len(value):
        raise DecodeError("checkpoint manifest length is invalid")
    manifest = json.loads(value[4:4 + length].decode("utf-8"))
    if (not isinstance(manifest, dict) or set(manifest) != MANIFEST_FIELDS
            or manifest["format"] != FORMAT or manifest["analysisVersion"] != analysis_version
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", analysis_version)
            or manifest["inputSha256"] != input_sha256 or not _count(manifest["inputBytes"], MAX_AUDIO)
            or manifest["mediaTime"] != MEDIA_TIME):
        raise DecodeError("checkpoint input, format or timeline does not match")
    for key in ("container", "codec"):
        if key == "codec" and manifest[key] is None:
            continue
        if not isinstance(manifest[key], str) or not 0 < len(manifest[key]) <= 80:
            raise DecodeError("invalid checkpoint container or codec")
    for key in ("sourceRateHz", "sourceChannels"):
        if manifest[key] is not None and not _count(manifest[key]):
            raise DecodeError("invalid checkpoint source sample metadata")
    if not _duration(manifest["containerDurationMs"]) or not _duration(manifest["primingMs"]):
        raise DecodeError("invalid checkpoint durations")
    pcm = manifest["pcm"]
    raw_samples = memoryview(value)[4 + length:]
    if (not isinstance(pcm, dict) or set(pcm) != PCM_FIELDS
            or pcm["encoding"] != "s16le" or pcm["rateHz"] != TARGET_RATE or pcm["channels"] != 1
            or not _count(pcm["sampleCount"], MAX_SAMPLES)
            or len(raw_samples) != 2 * pcm["sampleCount"] or sha256(raw_samples).hexdigest() != pcm["sha256"]):
        raise DecodeError("checkpoint PCM digest or timeline does not match")
    samples = array("h")
    samples.frombytes(raw_samples)
    if sys.byteorder != "little":
        samples.byteswap()
    return DecodedAudio(
        path=str(path), input_sha256=input_sha256, input_bytes=manifest["inputBytes"],
        container=manifest["container"], codec=manifest["codec"],
        source_rate=manifest["sourceRateHz"], source_channels=manifest["sourceChannels"],
        sample_rate=TARGET_RATE, sample_count=pcm["sampleCount"],
        container_duration_ms=manifest["containerDurationMs"],
        decoded_duration_ms=pcm["sampleCount"] * 1000.0 / TARGET_RATE,
        priming_ms=manifest["primingMs"], samples=samples,
    )
