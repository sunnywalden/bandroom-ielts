from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
import wave

from bandroom_acoustic.chunks import chunk_coverage, plan_chunks
from bandroom_acoustic.cli import build_analysis
from bandroom_acoustic.decode import DecodeError, TARGET_RATE, decode_audio
from bandroom_acoustic.schema import validate_analysis


def write_wav(path: Path, seconds: float = 30.0, rate: int = TARGET_RATE, channels: int = 1) -> None:
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"".join(int((index % 200) - 100).to_bytes(2, "little", signed=True) for index in range(frames * channels)))


class DecodeTest(unittest.TestCase):
    def test_wav_16k_mapping_and_hash(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.wav"
            write_wav(path, seconds=1.0, channels=2)
            decoded = decode_audio(path)
            self.assertEqual(decoded.sample_rate, TARGET_RATE)
            self.assertEqual(decoded.sample_count, TARGET_RATE)
            self.assertAlmostEqual(decoded.decoded_duration_ms, 1000.0)
            self.assertEqual(len(decoded.input_sha256), 64)
            self.assertAlmostEqual(decoded.media_time_ms(TARGET_RATE // 2), 500.0)

    def test_original_identity_is_checked_before_decoding(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.webm"
            path.write_bytes(b"invalid audio with a verifiable identity")
            missing_ffmpeg = str(path.with_name("missing-ffmpeg"))
            with self.assertRaisesRegex(DecodeError, "byte count does not match"):
                decode_audio(path, ffmpeg=missing_ffmpeg, expected_bytes=1)
            with self.assertRaisesRegex(DecodeError, "audio digest does not match"):
                decode_audio(path, ffmpeg=missing_ffmpeg, expected_sha256="0" * 64)

    def test_wav_with_truncated_samples_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.wav"
            write_wav(path, seconds=0.1)
            path.write_bytes(path.read_bytes()[:-2])
            with self.assertRaisesRegex(DecodeError, "before the declared sample count"):
                decode_audio(path)

    def test_chunk_plan_covers_tail_without_gaps(self):
        chunks = plan_chunks(30 * TARGET_RATE)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertEqual(chunks[0].start_sample, 0)
        self.assertEqual(chunks[-1].end_sample, 30 * TARGET_RATE)
        self.assertEqual(chunk_coverage(chunks, 30 * TARGET_RATE), [[0, 30 * TARGET_RATE]])
        for previous, current in zip(chunks, chunks[1:]):
            self.assertLessEqual(current.start_sample, previous.end_sample)

    def test_short_recording_is_one_complete_chunk(self):
        chunks = plan_chunks(5 * TARGET_RATE)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].end_sample, 5 * TARGET_RATE)


class AnalysisTest(unittest.TestCase):
    def test_cli_restores_exact_decoded_checkpoint_in_fresh_process(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio, checkpoint, output = (root / name for name in ("clip.wav", "decode.bin", "analysis.json"))
            write_wav(audio, seconds=1.0, channels=2)
            input_digest = sha256(audio.read_bytes()).hexdigest()
            command = [sys.executable, "-m", "bandroom_acoustic.cli",
                       "--analysis-version", "test-v1", "--input-sha256", input_digest]
            decode = subprocess.run(command + ["--audio", str(audio), "--decode-only",
                                               "--save-checkpoint", str(checkpoint)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(decode.returncode, 0, decode.stderr)
            decoded = checkpoint.read_bytes()
            audio.unlink()
            resume = command + ["--checkpoint", str(checkpoint), "--checkpoint-sha256", sha256(decoded).hexdigest(),
                                "--ffmpeg", str(root / "missing-ffmpeg"), "--out", str(output)]
            result = subprocess.run(resume, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 3, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["inputSha256"], input_digest)
            self.assertEqual(report["decoded"]["sampleCount"], TARGET_RATE)
            self.assertEqual(report["decoded"]["decodedDurationMs"], 1000.0)
            self.assertEqual(report["reason"], "qualified_analyzer_unavailable")
            output.unlink()
            wrong_size = subprocess.run(resume + ["--input-bytes", "1"], capture_output=True, text=True, check=False)
            self.assertEqual(wrong_size.returncode, 2, wrong_size.stderr)
            self.assertIn("byte count does not match", wrong_size.stderr)
            self.assertFalse(output.exists())
            checkpoint.write_bytes(decoded[:-1] + bytes([decoded[-1] ^ 1]))
            invalid = subprocess.run(resume, capture_output=True, text=True, check=False)
            self.assertEqual(invalid.returncode, 2, invalid.stderr)
            self.assertFalse(output.exists())

    def test_blocked_analysis_never_invents_errors(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.wav"
            write_wav(path, seconds=30.0)
            value = build_analysis(str(path), analysis_version="test-v1")
            self.assertEqual(value["state"], "blocked")
            self.assertEqual(value["reason"], "qualified_analyzer_unavailable")
            self.assertEqual(value["errors"], [])
            self.assertEqual(value["coverage"]["fraction"], 0.0)
            self.assertEqual(value["coverage"]["analyzedSamples"], [])
            self.assertEqual(validate_analysis(value), [])
            self.assertGreaterEqual(len(value["pipeline"]["chunks"]), 2)

    def test_cli_returns_blocked_exit_code(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.wav"
            out = Path(temporary) / "analysis.json"
            write_wav(path, seconds=30.0)
            result = subprocess.run(
                [sys.executable, "-m", "bandroom_acoustic.cli", "--audio", str(path), "--out", str(out)],
                cwd=Path(__file__).resolve().parents[1],
                env={"PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 3, result.stderr)
            value = json.loads(out.read_text())
            self.assertEqual(value["state"], "blocked")
            self.assertEqual(value["errors"], [])

    def test_invalid_audio_is_rejected(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "clip.wav"
            path.write_bytes(b"")
            with self.assertRaises(ValueError):
                build_analysis(str(path), analysis_version="test-v1")


if __name__ == "__main__":
    unittest.main()
