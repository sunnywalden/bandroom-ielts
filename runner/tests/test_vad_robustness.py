"""G2-prosody robustness: VAD pause timeline stable under additive noise.

Skips when the Silero model or a corpus recording is unavailable (assets are not
redistributed). Validates the fix for the waveform-only noise/aac jitter.
"""
import shutil
import tempfile
from pathlib import Path

import pytest

from runner import grounded_audio as ga
from runner import prosody

BASE = Path.home() / ".bandroom-acoustic"
MODEL = BASE / "silero_vad.onnx"
WAV = BASE / "corpus" / "suitcase_corpus" / "wav" / "hjk.wav"

pytestmark = pytest.mark.skipif(
    not (MODEL.exists() and WAV.exists() and shutil.which("ffmpeg")),
    reason="Silero model / corpus / ffmpeg not available",
)


def test_vad_pause_count_stable_under_noise():
    import numpy as np
    with tempfile.TemporaryDirectory() as wd:
        _, decoded = ga.decode_to_wav(WAV.read_bytes(), wd)
        audio = prosody.load_wav(decoded)
        assert audio.sample_rate == 16000
        orig = prosody.vad_pauses(audio.samples, audio.sample_rate)
        rng = np.random.default_rng(7)
        noisy = audio.samples + 0.01 * rng.standard_normal(len(audio.samples))
        deg = prosody.vad_pauses(noisy.astype(np.float32), audio.sample_rate)
        assert orig.pause_count == deg.pause_count
        assert abs(orig.total_seconds - deg.total_seconds) / orig.total_seconds <= 0.02
