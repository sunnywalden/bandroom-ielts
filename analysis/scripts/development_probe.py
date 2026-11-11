"""CPU development probe. The production CLI does not load these weights."""

from __future__ import annotations

from collections.abc import Iterator
import hashlib
from pathlib import Path
import re

import numpy as np
import torch
from torch import nn


PHONES = tuple("SIL AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH".split())
PHONE_INDEX = {phone: index for index, phone in enumerate(PHONES)}
BLANK = len(PHONES)
IGNORE = -100
FRAME_SAMPLES = 320
RECEPTIVE_SAMPLES = 400
FRAME_CENTER = (RECEPTIVE_SAMPLES - 1) / 2
FRAMES_PER_WINDOW = 800
CONTEXT_FRAMES = 100
ENCODER_SHA256 = "77ad8f985c97750d8d27d6950c917800d80732a141370bf316058bded71a6cbe"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def phone_symbol(label: str) -> str | None:
    symbol = re.sub(r"[012]$", "", label.upper())
    symbol = {"AX": "AH", "IX": "IH", "AXR": "ER", "EL": "L", "EN": "N", "EM": "M",
              "SIL": "SIL", "SP": "SIL", "SPN": "SIL"}.get(symbol, symbol)
    return symbol if symbol in PHONE_INDEX else None


def load_encoder(directory: Path) -> nn.Module:
    from transformers import HubertModel

    if sha256(directory / "model.safetensors") != ENCODER_SHA256:
        raise ValueError("DistilHuBERT weights differ from the pinned development source")
    encoder = HubertModel.from_pretrained(directory, local_files_only=True).eval()
    config = encoder.config
    if (list(config.conv_kernel) != [10, 3, 3, 3, 3, 2, 2]
            or list(config.conv_stride) != [5, 2, 2, 2, 2, 2, 2]
            or config.hidden_size != 768 or config.num_hidden_layers != 2):
        raise ValueError("DistilHuBERT config differs from the development timebase")
    return encoder


def frame_windows(total: int, offset: int = 0) -> Iterator[tuple[int, int, int, int]]:
    if total < 1 or not 0 <= offset < FRAMES_PER_WINDOW:
        raise ValueError("invalid frame count or window offset")
    for first in range(offset - FRAMES_PER_WINDOW if offset else 0, total, FRAMES_PER_WINDOW):
        start, end = max(0, first), min(total, first + FRAMES_PER_WINDOW)
        yield start, end, max(0, start - CONTEXT_FRAMES), min(total, end + CONTEXT_FRAMES)


@torch.inference_mode()
def encode(encoder: nn.Module, pcm: np.ndarray, offset: int = 0) -> tuple[torch.Tensor, int]:
    if pcm.ndim != 1 or len(pcm) < RECEPTIVE_SAMPLES:
        raise ValueError("expected at least 25 ms of mono 16 kHz audio")
    total = (len(pcm) - RECEPTIVE_SAMPLES) // FRAME_SAMPLES + 1
    features = torch.empty((total, 768))
    input_samples = 0
    for start, end, left, right in frame_windows(total, offset):
        samples = pcm[left * FRAME_SAMPLES:(right - 1) * FRAME_SAMPLES + RECEPTIVE_SAMPLES]
        inputs = torch.from_numpy(samples.astype(np.float32) / 32768)
        output = encoder(inputs[None]).last_hidden_state[0]
        if len(output) != right - left:
            raise ValueError("encoder output does not match the global frame timebase")
        features[start:end] = output[start - left:end - left]
        input_samples += len(samples)
    # Training needs normal tensors even when the frozen encoder uses inference mode.
    with torch.inference_mode(False):
        return features.clone(), input_samples


class PhoneProbe(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.frame_layer = nn.Sequential(nn.LayerNorm(768), nn.Linear(768, 128), nn.GELU())
        self.frame_head = nn.Linear(128, len(PHONES))
        self.ctc_head = nn.Linear(128, len(PHONES) + 1)
        self.boundary_head = nn.Linear(256, 1)

    def forward(self, features: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        hidden = self.frame_layer(features)
        previous = torch.cat((hidden[:1], hidden[:-1]))
        boundaries = self.boundary_head(torch.cat((previous, hidden), dim=-1)).squeeze(-1)
        return self.frame_head(hidden), self.ctc_head(hidden), boundaries
