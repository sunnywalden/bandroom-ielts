"""Decoded-PCM checkpoint transfer for the queue speaking path (iteration-31 rev3).

The grounded-prosody completion class binds the analysis to a verified decoded
input via the server's binary transfer machinery (lib/review-transfer.ts): the
runner decodes the original recording to 16 kHz s16le mono PCM, frames it as a
``bandroom-decode-v1`` checkpoint, PUTs it under a save_decode grant, then GETs it
back under a read_decode grant. The save PUT records the binary-v1 checkpoint
event that ``requireDecodedInput`` checks at completion; the GET re-verifies the
artifact digest under the current lease.

Body framing (parseCheckpointBody): uint32_be(manifestBytes) || manifestJson ||
PCM. The artifact SHA-256 covers the WHOLE body. The decode manifest does NOT
need canonical key ordering (only acoustic chunks do). Nullable manifest fields
must be present as null (strictObject). PCM is capped at 12 MiB (~393 s); longer
clips fail fast with a permanent ``decoded_too_long`` code.
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import wave
from pathlib import Path
from typing import Any, Callable, Mapping

from .audio import AudioError, sha256_bytes
from .grounded_audio import decode_to_wav

# 12 MiB PCM / 2 bytes per s16le sample (lib/review-transfer.ts pcmLimit).
PCM_LIMIT_SAMPLES = 6_291_456
DECODE_FORMAT = "bandroom-decode-v1"


def _ffprobe(source: Path, *, ffprobe: str | None = None) -> dict[str, Any]:
    executable = ffprobe or shutil.which("ffprobe")
    if not executable:
        return {}
    try:
        result = subprocess.run(
            [str(executable), "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(source)],
            capture_output=True, text=True, check=True,
        )
        parsed = json.loads(result.stdout)
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        return {}


def _probe_fields(source: Path, *, ffprobe: str | None = None) -> dict[str, Any]:
    probed = _ffprobe(source, ffprobe=ffprobe)
    fmt = probed.get("format") or {}
    streams = probed.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    container = str(fmt.get("format_name") or "unknown").split(",")[0][:80] or "unknown"
    duration = fmt.get("duration")
    try:
        duration_ms = float(duration) * 1000.0 if duration is not None else None
    except (TypeError, ValueError):
        duration_ms = None
    rate = audio.get("sample_rate")
    try:
        source_rate = int(rate) if rate is not None else None
    except (TypeError, ValueError):
        source_rate = None
    channels = audio.get("channels")
    try:
        source_channels = int(channels) if channels is not None else None
    except (TypeError, ValueError):
        source_channels = None
    codec = audio.get("codec_name")
    return {
        "container": container,
        "codec": str(codec) if codec else None,
        "sourceRateHz": source_rate,
        "sourceChannels": source_channels,
        "containerDurationMs": duration_ms,
        "primingMs": None,
    }


def read_pcm(decoded_wav: Path) -> tuple[bytes, int]:
    """Read raw s16le frames + sample count from the 16 kHz mono decoded WAV."""
    with wave.open(str(decoded_wav), "rb") as handle:
        if handle.getframerate() != 16_000 or handle.getnchannels() != 1 or handle.getsampwidth() != 2:
            raise AudioError("invalid_audio", "decoded WAV must be 16 kHz mono s16le")
        sample_count = handle.getnframes()
        pcm = handle.readframes(sample_count)
    if sample_count > PCM_LIMIT_SAMPLES:
        raise AudioError(
            "decoded_too_long",
            f"decoded PCM is {sample_count} samples (> {PCM_LIMIT_SAMPLES}, ~393 s); "
            "the decoded-checkpoint contract cannot bind this clip",
            retryable=False,
        )
    if len(pcm) != sample_count * 2:
        raise AudioError("invalid_audio", "decoded PCM length differs from the sample count")
    return pcm, sample_count


def encode_checkpoint_body(manifest: Mapping[str, Any], pcm: bytes) -> bytes:
    manifest_json = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(manifest_json) > 4096:
        raise AudioError("invalid_decode_checkpoint", "decode manifest exceeds 4096 bytes")
    return struct.pack(">I", len(manifest_json)) + manifest_json + pcm


def build_decode_manifest(
    *, analysis_version: str, input_sha256: str, input_bytes: int,
    pcm: bytes, sample_count: int, probe: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "format": DECODE_FORMAT,
        "analysisVersion": analysis_version,
        "inputSha256": input_sha256,
        "inputBytes": input_bytes,
        "container": probe.get("container") or "unknown",
        "codec": probe.get("codec"),
        "sourceRateHz": probe.get("sourceRateHz"),
        "sourceChannels": probe.get("sourceChannels"),
        "containerDurationMs": probe.get("containerDurationMs"),
        "primingMs": probe.get("primingMs"),
        "pcm": {
            "encoding": "s16le", "rateHz": 16_000, "channels": 1,
            "sampleCount": sample_count, "sha256": sha256_bytes(pcm),
        },
        "mediaTime": {"originMs": 0, "samplesPerSecond": 16_000},
    }


def commit_decoded_checkpoint(
    client: Any,
    task_id: str,
    fence: int,
    raw: bytes,
    *,
    analysis_version: str,
    workdir: str | Path,
    run_id: str | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    decode: Callable[..., tuple[Path, Path]] = decode_to_wav,
    logger: Any = None,
) -> int:
    """Decode -> save_decode PUT -> read_decode GET; return the sample count.

    Raises AudioError (decoded_too_long / invalid_audio) or ToolError (transfer
    failure with a machine code) for the orchestrator to classify. The lease is
    renewed by the caller's LeaseRenewer across this whole window.
    """
    source, decoded = decode(raw, workdir, ffmpeg=ffmpeg)
    pcm, sample_count = read_pcm(decoded)
    probe = _probe_fields(source, ffprobe=ffprobe)
    manifest = build_decode_manifest(
        analysis_version=analysis_version,
        input_sha256=sha256_bytes(raw), input_bytes=len(raw),
        pcm=pcm, sample_count=sample_count, probe=probe,
    )
    body = encode_checkpoint_body(manifest, pcm)
    artifact_sha = sha256_bytes(body)
    save_grant = client.call_tool(
        "get_review_transfer",
        {"taskId": task_id, "fence": int(fence), "action": "save_decode",
         "artifactSha256": artifact_sha, "bytes": len(body)},
        client_run_id=run_id,
    )
    if not isinstance(save_grant, Mapping) or not save_grant.get("url"):
        raise AudioError("transfer_grant_invalid", "save_decode grant missing url", retryable=True)
    client.put_bytes(
        str(save_grant["url"]), body,
        headers={"Authorization": str(save_grant["authorization"])},
    )
    read_grant = client.call_tool(
        "get_review_transfer",
        {"taskId": task_id, "fence": int(fence), "action": "read_decode"},
        client_run_id=run_id,
    )
    if not isinstance(read_grant, Mapping) or not read_grant.get("url"):
        raise AudioError("transfer_grant_invalid", "read_decode grant missing url", retryable=True)
    downloaded = client.get_bytes(
        str(read_grant["url"]),
        headers={"Authorization": str(read_grant["authorization"])},
    )
    if sha256_bytes(downloaded) != artifact_sha:
        raise AudioError(
            "transfer_integrity_failed",
            "read_decode artifact digest differs from the committed checkpoint",
            retryable=True,
        )
    if logger:
        logger.info(json.dumps({
            "event": "decoded_checkpoint_committed", "task": task_id,
            "sampleCount": sample_count, "artifactSha256": artifact_sha,
        }, ensure_ascii=False))
    return sample_count