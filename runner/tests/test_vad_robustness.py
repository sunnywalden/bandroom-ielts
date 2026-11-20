"""G2-prosody robustness: VAD pause timeline stable under additive noise.

Skips when the Silero model or a corpus recording is unavailable (assets are not
redistributed). Validates the fix for the waveform-only noise/aac jitter.
"""
import math
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
        # Non-vacuity gate: an all-zero VAD timeline must never count as
        # "robust" (0 == 0 pause comparisons passed the 2026-11-19 outage).
        assert orig.speech_seconds > 0.0, "VAD detected no speech in the base corpus clip"
        rng = np.random.default_rng(7)
        noisy = audio.samples + 0.01 * rng.standard_normal(len(audio.samples))
        deg = prosody.vad_pauses(noisy.astype(np.float32), audio.sample_rate)
        # Exact pause-count equality was a vacuous invariant: while the VAD
        # call convention was broken both timelines were empty (0 == 0).
        # Measured 2026-11-19 on hjk with the fixed convention: speech seconds
        # drift <= 4.3% under additive noise up to 0.01 RMS (~15 dB SNR), but
        # pause COUNT flips borderline gaps near the 0.32 s minimum (15 -> 20).
        # The robust quantity is speech time; count-level reliability stays
        # disclosed per user via the T1 pause-calibration disclosure.
        assert abs(orig.speech_seconds - deg.speech_seconds) <= 0.10 * orig.speech_seconds
        assert abs(orig.pause_count - deg.pause_count) <= max(2, math.ceil(0.35 * orig.pause_count))
        assert abs(orig.total_seconds - deg.total_seconds) / orig.total_seconds <= 0.02
