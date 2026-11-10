from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
import wave

from bandroom_acoustic.chunks import chunk_coverage, plan_chunks
from bandroom_acoustic.cli import build_analysis
from bandroom_acoustic.decode import TARGET_RATE, decode_audio
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
