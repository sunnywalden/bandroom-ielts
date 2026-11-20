"""Non-vacuous VAD speech-detection gate (regression for the 2026-11-19 outage).

Root cause being locked down: ``vad_pauses`` fed 512-sample chunks to the
Silero v5 ONNX, whose official calling convention prepends 64 samples of
context from the previous chunk (576-sample input at 16 kHz). The model's
dynamic input shape hid the mismatch: every frame probability collapsed to
~0, so real recordings produced ``speech_duration_seconds=0`` and the coach
feedback degenerated to "please re-record". The earlier robustness test
passed vacuously because it only compared empty pause timelines (0 == 0).

These tests assert POSITIVE speech detection on a committed real-speech
fixture, so an all-zero VAD can never pass again. The fixture is TTS speech
generated on the owner machine (no corpus redistribution); the silence case
guards against a model that flags everything.
"""
from pathlib import Path

import numpy as np
import pytest

from runner import prosody

FIXTURE = Path(__file__).parent / "fixtures" / "vad-speech-16k.wav"
MODEL = Path.home() / ".bandroom-acoustic" / "silero_vad.onnx"

pytestmark = pytest.mark.skipif(
    not MODEL.exists(),
    reason="Silero model not available (assets are not redistributed)",
)


def _load_fixture() -> np.ndarray:
    audio = prosody.load_wav(FIXTURE)
    assert audio.sample_rate == 16000
    return audio.samples


def test_fixture_is_audible_speech():
    """The gate itself must not be vacuous: the fixture carries real energy."""
    samples = _load_fixture()
    rms = float(np.sqrt(np.mean(samples**2)))
    assert rms > 0.01, f"speech fixture is silent (rms={rms})"
    assert len(samples) / 16000 > 3.0


def test_vad_detects_speech_on_real_recording():
    samples = _load_fixture()
    detection = prosody.vad_pauses(samples, 16000)
    total = len(samples) / 16000
    # The fixture is continuous speech with a single sentence break; the VAD
    # must see most of it as speech, not an empty timeline.
    assert detection.speech_seconds > 0.5 * total, (
        f"VAD degenerate: speech={detection.speech_seconds:.2f}s of {total:.2f}s"
    )
    assert detection.speech_span[1] > 0.8 * total
    assert detection.total_seconds == pytest.approx(total, abs=0.05)


def test_vad_rejects_silence():
    silence = np.zeros(16000 * 4, dtype=np.float64)
    detection = prosody.vad_pauses(silence, 16000)
    assert detection.speech_seconds == 0.0
    assert detection.pauses == []


def test_vad_probabilities_follow_official_context_convention():
    """Differential check against the official silero-vad wrapper convention.

    The reference prepends the previous chunk's last 64 samples as context
    (input = 64 + 512). ``vad_frame_probabilities`` must agree frame-for-frame
    within float noise; feeding bare 512-sample chunks collapses the
    probabilities to ~0.
    """
    samples = _load_fixture()
    sess = prosody._vad_session()
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    sr = np.array(16000, dtype=np.int64)
    reference: list[float] = []
    for first in range(0, len(samples) - 512 + 1, 512):
        block = samples[first:first + 512].astype(np.float32)[None, :]
        inp = np.concatenate([context, block], axis=1)
        out, state = sess.run(None, {"input": inp, "state": state, "sr": sr})
        context = inp[:, -64:]
        reference.append(float(out[0][0]))
    assert max(reference) > 0.9, "reference convention itself sees no speech"

    actual = prosody.vad_frame_probabilities(samples)
    assert actual.shape == (len(reference),)
    assert np.allclose(actual, np.asarray(reference), atol=1e-6), (
        "vad_frame_probabilities diverged from the official convention: "
        f"max |diff| = {np.max(np.abs(actual - np.asarray(reference)))}"
    )
    speech_frames = int(np.sum(np.asarray(reference) >= prosody.VAD_THRESHOLD))
    assert speech_frames > 0
    assert prosody.vad_pauses(samples, 16000).speech_seconds > 0.0
