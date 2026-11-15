"""Audio reassembly and whole-clip transcoding for the coach runner.

DashScope's omni model accepts an ``input_audio`` data URI whose encoded size
must stay under 10 MB, and clips up to 3 hours.  Recordings upload to Bandroom
can be up to 12 MiB, so an mp3/aac file may exceed the model limit after
base64 encoding.  We therefore transcode the *whole* clip at the highest
bitrate that fits, and fail explicitly if nothing fits.  We never trim or
silently truncate.

All subprocess calls are injected in tests; the real functions use ffmpeg /
ffprobe from PATH (checked with ``shutil.which``).
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

# DashScope documentation: base64-encoded input audio must be under 10 MB and
# at most 3 hours per file.  We keep a margin below the encoded limit so a
# provider that interprets MB as 10^6 still accepts the clip.
MAX_ENCODED_BYTES = 9_500_000
MAX_DURATION_SECONDS = 3 * 60 * 60
DEFAULT_BITRATES_KBPS: tuple[int, ...] = (64, 48, 32, 24, 16)
DATA_URI_PREFIX = "data:;base64,"


class AudioError(Exception):
    """Classified audio failure with an explicit, stable code."""

    def __init__(self, code: str, message: str = "", *, retryable: bool = False):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.retryable = retryable


@dataclass(frozen=True)
class PreparedAudio:
    """A whole-clip mp3 ready for a DashScope audio message."""

    base64: str
    data_uri: str
    format: str
    byte_length: int
    encoded_length: int
    duration_seconds: float
    bitrate_kbps: int
    sha256: str


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def reassemble(
    chunks: Iterable[bytes],
    *,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
) -> bytes:
    """Concatenate byte ranges and verify size/digest before decoding.

    The caller must supply the server-reported total size.  A mismatch means a
    range was lost or ordering was wrong; never analyse a partial recording.
    """
    data = b"".join(chunks)
    if expected_size is not None and len(data) != expected_size:
        raise AudioError(
            "recording_size_mismatch",
            f"reassembled {len(data)} bytes, server reported {expected_size}",
        )
    if not data:
        raise AudioError("recording_empty", "the submitted recording is empty")
    digest = sha256_bytes(data)
    if expected_sha256 and digest != expected_sha256.lower():
        raise AudioError(
            "recording_sha256_mismatch",
            "reassembled recording does not match the submitted digest",
        )
    return data


def probe_duration_seconds(
    path: Path,
    *,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    ffprobe: str | None = None,
) -> float:
    executable = ffprobe or shutil.which("ffprobe")
    if not executable:
        raise AudioError("ffprobe_unavailable", "ffprobe is required to measure clip length")
    command = [
        executable, "-v", "error", "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    try:
        result = run(command, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AudioError("ffprobe_failed", f"ffprobe failed: {exc}", retryable=True) from exc
    try:
        value = json.loads(result.stdout)["format"]["duration"]
        return float(value)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise AudioError("ffprobe_failed", "ffprobe returned no duration", retryable=True) from exc


def transcode_whole_clip(
    source: Path,
    destination: Path,
    *,
    bitrate_kbps: int,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    ffmpeg: str | None = None,
) -> Path:
    """Transcode the entire source to mp3.  No ``-t``/``-ss``: no truncation."""
    executable = ffmpeg or shutil.which("ffmpeg")
    if not executable:
        raise AudioError("ffmpeg_unavailable", "ffmpeg is required for audio review")
    command = [
        executable, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source), "-vn", "-c:a", "libmp3lame",
        "-b:a", f"{int(bitrate_kbps)}k", "-f", "mp3", str(destination),
    ]
    try:
        run(command, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AudioError("transcode_failed", f"ffmpeg failed: {exc}", retryable=True) from exc
    if not destination.exists() or destination.stat().st_size == 0:
        raise AudioError("transcode_failed", "ffmpeg produced no output", retryable=True)
    return destination


def prepare_audio(
    raw: bytes,
    *,
    workdir: Path,
    bitrates_kbps: Sequence[int] = DEFAULT_BITRATES_KBPS,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> PreparedAudio:
    """Decode/transcode the whole clip and pre-check the encoded size."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    source = workdir / "source.audio"
    source.write_bytes(raw)
    try:
        duration = probe_duration_seconds(source, run=run, ffprobe=ffprobe)
        if duration <= 0:
            raise AudioError("invalid_audio", "clip duration is zero or unreadable")
        if duration > MAX_DURATION_SECONDS:
            raise AudioError(
                "audio_too_long",
                f"clip is {duration:.1f}s; the model limit is {MAX_DURATION_SECONDS}s",
            )
        last_size = 0
        for bitrate in bitrates_kbps:
            destination = workdir / f"clip-{int(bitrate)}k.mp3"
            transcode_whole_clip(
                source, destination, bitrate_kbps=bitrate, run=run, ffmpeg=ffmpeg
            )
            encoded_bytes = destination.read_bytes()
            last_size = len(encoded_bytes)
            encoded_length = 4 * ((len(encoded_bytes) + 2) // 3)  # base64 length
            if encoded_length < MAX_ENCODED_BYTES:
                payload = base64.b64encode(encoded_bytes).decode("ascii")
                if len(payload) >= MAX_ENCODED_BYTES:
                    continue
                return PreparedAudio(
                    base64=payload,
                    data_uri=DATA_URI_PREFIX + payload,
                    format="mp3",
                    byte_length=len(encoded_bytes),
                    encoded_length=len(payload),
                    duration_seconds=duration,
                    bitrate_kbps=int(bitrate),
                    sha256=sha256_bytes(encoded_bytes),
                )
        raise AudioError(
            "audio_encoded_too_large",
            f"whole clip still {last_size} bytes at the lowest bitrate; refusing to truncate",
        )
    finally:
        # Best effort; the caller uses a temporary directory anyway.
        try:
            source.unlink(missing_ok=True)
        except OSError:
            pass