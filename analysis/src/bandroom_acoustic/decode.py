"""Decode browser audio to a canonical 16 kHz mono sample timeline.

The original container is never modified. All analysis coordinates are samples
on this decoded timeline; media-time conversion is explicit and one-way.
"""

from __future__ import annotations

from array import array
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import wave

TARGET_RATE = 16_000
MAX_AUDIO = 12 * 1024 * 1024
MAX_SAMPLES = MAX_AUDIO // 2
FFMPEG_TIMEOUT = 60


class DecodeError(ValueError):
    """The input cannot be decoded into the canonical timeline."""


@dataclass(frozen=True)
class DecodedAudio:
    path: str
    input_sha256: str
    input_bytes: int
    container: str
    codec: str | None
    source_rate: int | None
    source_channels: int | None
    sample_rate: int
    sample_count: int
    container_duration_ms: float | None
    decoded_duration_ms: float
    priming_ms: float | None
    samples: array

    def media_time_ms(self, sample: int) -> float:
        if sample < 0 or sample > self.sample_count:
            raise ValueError("sample is outside the decoded timeline")
        return sample * 1000.0 / self.sample_rate

    def public(self) -> dict:
        data = asdict(self)
        data.pop("samples")
        return data


def _mono_values(frames: bytes, width: int, channels: int) -> list[float]:
    if width == 1:
        values = [(byte - 128) * 256.0 for byte in frames]
    elif width == 2:
        decoded = array("h")
        decoded.frombytes(frames)
        if sys.byteorder != "little":
            decoded.byteswap()
        values = [float(value) for value in decoded]
    elif width == 4:
        decoded = array("i")
        decoded.frombytes(frames)
        if sys.byteorder != "little":
            decoded.byteswap()
        values = [value / 65536.0 for value in decoded]
    else:
        raise DecodeError(f"unsupported WAV sample width: {width}")
    if channels > 1:
        return [sum(values[index:index + channels]) / channels
                for index in range(0, len(values), channels)]
    return values


def _resample(values: list[float], source_rate: int, target_rate: int = TARGET_RATE) -> list[float]:
    if source_rate == target_rate:
        return values
    if not values:
        return []
    duration = len(values) / source_rate
    count = max(1, round(duration * target_rate))
    result: list[float] = []
    for index in range(count):
        position = index * source_rate / target_rate
        left = min(int(position), len(values) - 1)
        right = min(left + 1, len(values) - 1)
        fraction = position - left
        result.append(values[left] * (1 - fraction) + values[right] * fraction)
    return result


def _to_pcm16(values: list[float]) -> array:
    return array("h", (max(-32768, min(32767, int(round(value)))) for value in values))


def _decode_wav(path: Path) -> tuple[array, int, int, float]:
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frame_count = handle.getnframes()
            if frame_count <= 0 or rate <= 0 or channels <= 0:
                raise DecodeError("invalid WAV sample metadata")
            if frame_count * width * channels > MAX_AUDIO or round(frame_count * TARGET_RATE / rate) > MAX_SAMPLES:
                raise DecodeError("decoded audio exceeds the sample limit")
            frames = handle.readframes(frame_count)
    except (wave.Error, EOFError) as exc:
        raise DecodeError(f"invalid WAV container: {exc}") from exc
    if len(frames) != frame_count * width * channels:
        raise DecodeError("WAV audio ended before the declared sample count")
    values = _mono_values(frames, width, channels)
    values = _resample(values, rate)
    return _to_pcm16(values), rate, channels, frame_count * 1000.0 / rate


_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_AUDIO = re.compile(r"Audio:\s*([^,\s]+)(?:[^,]*),\s*(\d+)\s*Hz,\s*([^,]+)")


def _probe_ffmpeg(path: Path, ffmpeg: str) -> tuple[float | None, str | None, int | None, int | None]:
    result = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-protocol_whitelist", "file,pipe", "-i", str(path)],
                            capture_output=True, check=False, timeout=FFMPEG_TIMEOUT)
    text = result.stderr.decode("utf-8", "replace")
    duration = None
    match = _DURATION.search(text)
    if match:
        hours, minutes, seconds = match.groups()
        duration = (int(hours) * 3600 + int(minutes) * 60 + float(seconds)) * 1000.0
    codec = rate = channels = None
    audio = _AUDIO.search(text)
    if audio:
        codec, rate_text, channel_text = audio.groups()
        rate = int(rate_text)
        channels = 2 if "stereo" in channel_text else 1
    return duration, codec, rate, channels


def _decode_ffmpeg(path: Path, ffmpeg: str) -> tuple[array, int | None, int | None, float | None, str | None]:
    duration, codec, rate, channels = _probe_ffmpeg(path, ffmpeg)
    # Decode past the limit by at most one second so oversized input fails instead of being accepted as truncated.
    output_seconds = MAX_SAMPLES / TARGET_RATE + 1
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", str(path),
         "-map", "0:a:0", "-ac", "1", "-ar", str(TARGET_RATE), "-t", str(output_seconds), "-f", "s16le", "pipe:1"],
        capture_output=True, check=False, timeout=FFMPEG_TIMEOUT,
    )
    if result.returncode != 0:
        raise DecodeError(result.stderr.decode("utf-8", "replace").strip() or "ffmpeg decode failed")
    if len(result.stdout) > MAX_SAMPLES * 2 or len(result.stdout) % 2:
        raise DecodeError("decoded PCM has an invalid byte count")
    samples = array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples, rate, channels, duration, codec


def decode_audio(path: str | Path, ffmpeg: str = "ffmpeg", *,
                 expected_sha256: str | None = None, expected_bytes: int | None = None) -> DecodedAudio:
    source = Path(path).resolve(strict=True)
    if not source.is_file():
        raise DecodeError("input is not a file")
    with source.open("rb") as stream:
        original = stream.read(MAX_AUDIO + 1)
    if not 0 < len(original) <= MAX_AUDIO:
        raise DecodeError("original audio byte count is outside the supported range")
    if expected_bytes is not None and len(original) != expected_bytes:
        raise DecodeError("original audio byte count does not match the expected input")
    digest = sha256(original).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256:
        raise DecodeError("original audio digest does not match the expected input")
    suffix = source.suffix.lower()
    # Decoder input and published provenance must refer to the same immutable bytes.
    with TemporaryDirectory(prefix="bandroom-audio-") as directory:
        snapshot = Path(directory) / "recording"
        snapshot.write_bytes(original)
        try:
            if suffix in (".wav", ".wave"):
                samples, source_rate, channels, container_ms = _decode_wav(snapshot)
                codec = "pcm"
            else:
                samples, source_rate, channels, container_ms, codec = _decode_ffmpeg(snapshot, ffmpeg)
        except subprocess.TimeoutExpired as exc:
            raise DecodeError("audio decoding exceeded its time limit") from exc
    if len(samples) == 0:
        raise DecodeError("decoded audio is empty")
    return DecodedAudio(
        path=str(source), input_sha256=digest, input_bytes=len(original),
        container=suffix.lstrip(".") or "unknown", codec=codec,
        source_rate=source_rate, source_channels=channels,
        sample_rate=TARGET_RATE, sample_count=len(samples),
        container_duration_ms=container_ms,
        decoded_duration_ms=len(samples) * 1000.0 / TARGET_RATE,
        priming_ms=None, samples=samples,
    )
