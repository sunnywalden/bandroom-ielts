from __future__ import annotations

import base64
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from runner.audio import (
    MAX_ENCODED_BYTES,
    AudioError,
    prepare_audio,
    reassemble,
    sha256_bytes,
)


def _completed(command, stdout=""):
    return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")


def _fake_run(duration=30.0, sizes=None):
    sizes = sizes or {}

    def run(command, **kwargs):
        if command[0].endswith("ffprobe"):
            return _completed(
                command, stdout=json.dumps({"format": {"duration": str(duration)}})
            )
        bitrate = int(command[command.index("-b:a") + 1].rstrip("k"))
        destination = Path(command[-1])
        destination.write_bytes(b"a" * sizes[bitrate])
        return _completed(command)

    return run


def test_transcodes_whole_clip_and_prechecks_size(tmp_path):
    run = _fake_run(sizes={64: 1_000_000, 48: 500_000, 32: 200_000})
    source = b"raw-recording"
    prepared = prepare_audio(
        source,
        workdir=tmp_path,
        bitrates_kbps=(64, 48, 32),
        ffmpeg="/usr/bin/ffmpeg",
        ffprobe="/usr/bin/ffprobe",
        run=run,
    )
    assert prepared.format == "mp3"
    assert prepared.bitrate_kbps == 64
    assert prepared.duration_seconds == 30.0
    assert prepared.data_uri.startswith("data:;base64,")
    assert base64.b64decode(prepared.base64) == b"a" * 1_000_000
    assert prepared.encoded_length < MAX_ENCODED_BYTES


def test_drops_bitrate_when_encoded_too_large(tmp_path):
    # 64k output encodes above 10 MB; 48k fits.
    run = _fake_run(sizes={64: 8_000_000, 48: 4_000_000, 32: 1_000_000})
    prepared = prepare_audio(
        b"raw",
        workdir=tmp_path,
        bitrates_kbps=(64, 48, 32),
        ffmpeg="/usr/bin/ffmpeg",
        ffprobe="/usr/bin/ffprobe",
        run=run,
    )
    assert prepared.bitrate_kbps == 48
    assert prepared.encoded_length < MAX_ENCODED_BYTES
    assert prepared.duration_seconds == 30.0


def test_fails_when_all_bitrates_are_too_large(tmp_path):
    run = _fake_run(sizes={64: 9_000_000, 48: 9_000_000, 32: 9_000_000})
    with pytest.raises(AudioError) as caught:
        prepare_audio(
            b"raw",
            workdir=tmp_path,
            bitrates_kbps=(64, 48, 32),
            ffmpeg="/usr/bin/ffmpeg",
            ffprobe="/usr/bin/ffprobe",
            run=run,
        )
    assert caught.value.code == "audio_encoded_too_large"
    assert caught.value.retryable is False


def test_over_three_hours_fails_without_transcoding(tmp_path):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return _completed(
            command, stdout=json.dumps({"format": {"duration": "10801"}})
        )

    with pytest.raises(AudioError) as caught:
        prepare_audio(
            b"raw",
            workdir=tmp_path,
            ffmpeg="/usr/bin/ffmpeg",
            ffprobe="/usr/bin/ffprobe",
            run=run,
        )
    assert caught.value.code == "audio_too_long"
    assert len(calls) == 1  # only ffprobe; no ffmpeg, no truncation


def test_transcode_command_has_no_truncation_flags(tmp_path):
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        if command[0].endswith("ffprobe"):
            return _completed(
                command, stdout=json.dumps({"format": {"duration": "60"}})
            )
        Path(command[-1]).write_bytes(b"b" * 1000)
        return _completed(command)

    prepare_audio(
        b"raw",
        workdir=tmp_path,
        bitrates_kbps=(64,),
        ffmpeg="/usr/bin/ffmpeg",
        ffprobe="/usr/bin/ffprobe",
        run=run,
    )
    ffmpeg_command = commands[-1]
    assert "-t" not in ffmpeg_command
    assert "-ss" not in ffmpeg_command
    assert "-to" not in ffmpeg_command
    assert "-c:a" in ffmpeg_command and "libmp3lame" in ffmpeg_command


def test_reassemble_verifies_size_and_sha():
    data = b"first-second"
    digest = hashlib.sha256(data).hexdigest()
    assert reassemble([b"first-", b"second"], expected_size=len(data)) == data
    assert (
        reassemble(
            [b"first-", b"second"], expected_size=len(data), expected_sha256=digest
        )
        == data
    )

    with pytest.raises(AudioError) as caught:
        reassemble([b"first-", b"sec"], expected_size=len(data))
    assert caught.value.code == "recording_size_mismatch"

    with pytest.raises(AudioError) as caught:
        reassemble(
            [b"first-", b"second"],
            expected_size=len(data),
            expected_sha256="0" * 64,
        )
    assert caught.value.code == "recording_sha256_mismatch"


def test_reassemble_rejects_empty():
    with pytest.raises(AudioError) as caught:
        reassemble([], expected_size=0)
    assert caught.value.code == "recording_empty"


def test_missing_ffmpeg_is_explicit(monkeypatch, tmp_path):
    monkeypatch.setattr("runner.audio.shutil.which", lambda name: None)
    with pytest.raises(AudioError) as caught:
        prepare_audio(
            b"raw",
            workdir=tmp_path,
            ffmpeg=None,
            ffprobe="/usr/bin/ffprobe",
            run=_fake_run(),
        )
    assert caught.value.code == "ffmpeg_unavailable"


def test_sha256_bytes_helper():
    assert sha256_bytes(b"abc") == hashlib.sha256(b"abc").hexdigest()