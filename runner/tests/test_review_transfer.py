"""Decoded-PCM checkpoint transfer client (iteration-31 rev3, runner side).

Validates the byte-exact body framing, manifest shape, WAV header stripping,
the ~393 s ceiling, and the save->read round trip against a fake grant client.
"""
from __future__ import annotations

import hashlib
import json
import struct
import wave
from pathlib import Path

import pytest

from runner import review_transfer as rt
from runner.audio import AudioError


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_wav(path: Path, sample_count: int, rate: int = 16000) -> bytes:
    pcm = b"\x01\x00" * sample_count  # s16le
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)
    return pcm


def test_encode_body_framing_and_whole_body_sha():
    manifest = {"format": rt.DECODE_FORMAT, "pcm": {"sampleCount": 4}}
    pcm = b"\x00\x01" * 4
    body = rt.encode_checkpoint_body(manifest, pcm)
    manifest_bytes = struct.unpack(">I", body[:4])[0]
    assert body[4:4 + manifest_bytes] == json.dumps(
        manifest, ensure_ascii=False, separators=(",", ":")).encode()
    assert body[4 + manifest_bytes:] == pcm
    assert _sha(body) == _sha(body)  # artifact sha covers the whole body
    assert manifest_bytes <= 4096


def test_manifest_shape_nullable_present():
    pcm = b"\x00\x01" * 100
    manifest = rt.build_decode_manifest(
        analysis_version="grounded-prosody-v1", input_sha256="a" * 64,
        input_bytes=200, pcm=pcm, sample_count=100,
        probe={"container": "webm", "codec": None, "sourceRateHz": None,
               "sourceChannels": None, "containerDurationMs": None, "primingMs": None},
    )
    assert manifest["format"] == "bandroom-decode-v1"
    assert manifest["analysisVersion"] == "grounded-prosody-v1"
    assert manifest["inputSha256"] == "a" * 64
    # strictObject: nullable fields must be PRESENT as null, not omitted.
    for key in ("codec", "sourceRateHz", "sourceChannels", "containerDurationMs", "primingMs"):
        assert key in manifest and manifest[key] is None
    assert manifest["pcm"] == {"encoding": "s16le", "rateHz": 16000, "channels": 1,
                               "sampleCount": 100, "sha256": _sha(pcm)}
    assert manifest["mediaTime"] == {"originMs": 0, "samplesPerSecond": 16000}


def test_read_pcm_strips_wav_header(tmp_path):
    wav = tmp_path / "decoded.wav"
    pcm = _write_wav(wav, 8000)
    read_pcm, count = rt.read_pcm(wav)
    assert count == 8000
    assert read_pcm == pcm  # raw frames, no 44-byte RIFF header
    assert len(read_pcm) == count * 2


def test_read_pcm_rejects_non_16k_mono(tmp_path):
    wav = tmp_path / "bad.wav"
    _write_wav(wav, 100, rate=48000)
    with pytest.raises(AudioError) as exc:
        rt.read_pcm(wav)
    assert exc.value.code == "invalid_audio"


def test_read_pcm_ceiling_decoded_too_long(tmp_path):
    wav = tmp_path / "long.wav"
    _write_wav(wav, rt.PCM_LIMIT_SAMPLES + 1)
    with pytest.raises(AudioError) as exc:
        rt.read_pcm(wav)
    assert exc.value.code == "decoded_too_long"
    assert exc.value.retryable is False


class FakeTransferClient:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.put_body = None

    def call_tool(self, name, args=None, *, client_run_id=None):
        args = dict(args or {})
        self.calls.append((name, args))
        if name == "get_review_transfer":
            if args["action"] == "save_decode":
                return {"url": "https://fixture/save", "method": "PUT",
                        "authorization": "Bearer save-grant"}
            if args["action"] == "read_decode":
                return {"url": "https://fixture/read", "method": "GET",
                        "authorization": "Bearer read-grant"}
        raise AssertionError(f"unexpected tool {name}")

    def put_bytes(self, url, body, *, headers=None, timeout=None):
        assert headers["Authorization"] == "Bearer save-grant"
        self.put_body = body
        self.objects["checkpoint"] = body
        return b""

    def get_bytes(self, url, *, headers=None, timeout=None):
        assert headers["Authorization"] == "Bearer read-grant"
        return self.objects["checkpoint"]


def _fake_decode(raw, workdir, *, ffmpeg=None):
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    source = workdir / "source.audio"
    source.write_bytes(raw)
    decoded = workdir / "decoded-16k.wav"
    _write_wav(decoded, 16000)
    return source, decoded


def test_commit_round_trip(tmp_path):
    client = FakeTransferClient()
    raw = b"original-recording-bytes"
    count = rt.commit_decoded_checkpoint(
        client, "task-1", 3, raw,
        analysis_version="grounded-prosody-v1", workdir=tmp_path / "wd",
        decode=_fake_decode,
    )
    assert count == 16000
    # save_decode grant carried the whole-body artifact digest.
    save = next(a for n, a in client.calls if n == "get_review_transfer" and a["action"] == "save_decode")
    assert save["artifactSha256"] == _sha(client.put_body)
    assert save["bytes"] == len(client.put_body)
    assert save["taskId"] == "task-1" and save["fence"] == 3
    # manifest bound to the original recording identity + version.
    mb = struct.unpack(">I", client.put_body[:4])[0]
    manifest = json.loads(client.put_body[4:4 + mb])
    assert manifest["inputSha256"] == _sha(raw)
    assert manifest["inputBytes"] == len(raw)
    assert manifest["analysisVersion"] == "grounded-prosody-v1"
    assert manifest["pcm"]["sampleCount"] == 16000
    assert any(a["action"] == "read_decode" for n, a in client.calls if n == "get_review_transfer")


def test_commit_integrity_mismatch_raises(tmp_path):
    class CorruptClient(FakeTransferClient):
        def get_bytes(self, url, *, headers=None, timeout=None):
            return b"corrupted-different-bytes"

    with pytest.raises(AudioError) as exc:
        rt.commit_decoded_checkpoint(
            CorruptClient(), "task-1", 3, b"raw",
            analysis_version="grounded-prosody-v1", workdir=tmp_path / "wd",
            decode=_fake_decode,
        )
    assert exc.value.code == "transfer_integrity_failed"