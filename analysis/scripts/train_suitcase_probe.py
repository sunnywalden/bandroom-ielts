#!/usr/bin/env python3
"""Train the internal development probe on publisher-annotated free speech."""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import json
from pathlib import Path
import random
import re
import subprocess
from tempfile import TemporaryDirectory
from time import perf_counter
from zipfile import ZipFile

import numpy as np
from safetensors.torch import save_file
import torch
from torch.nn import functional as F

from development_probe import (
    BLANK, ENCODER_SHA256, FRAME_CENTER, FRAME_SAMPLES, IGNORE, PHONE_INDEX, PHONES,
    PhoneProbe, encode, load_encoder, phone_symbol, sha256,
)


PUBLISHER_SHA256 = "cd25543e31a1156319bc66a9c808bf44c966786689b7bb309c9b374adff0f3a5"
EVALUATION = frozenset(("hjk", "rrbi", "lxc"))
CALIBRATION = frozenset(("ebvs", "svbi"))
INTERVAL = re.compile(
    r'intervals \[\d+\]:\s*xmin = ([0-9.]+)\s*xmax = ([0-9.]+)\s*text = "([^"\n]*)"'
)


@dataclass(frozen=True)
class Interval:
    start: float
    end: float
    label: str


def tiers(text: str) -> dict[str, list[Interval]]:
    result = {}
    for tier in re.split(r"\n\s*item \[\d+\]:", text)[1:]:
        name = re.search(r'name = "([^"]+)"', tier)
        if name:
            result[name[1]] = [Interval(float(start), float(end), label.strip())
                               for start, end, label in INTERVAL.findall(tier)]
    if not result.get("words") or not result.get("phones"):
        raise ValueError("missing publisher word or phone intervals")
    return result


def annotation(label: str) -> tuple[str | None, str | None, str]:
    parts = [part.strip() for part in label.split(",")]
    if len(parts) == 3 and parts[2].lower() in ("s", "d", "a"):
        target, actual, kind = parts
        return phone_symbol(target), phone_symbol(actual), kind.lower()
    normal = phone_symbol(label)
    return normal, normal, "match"


def decode(wav: Path, ffmpeg: str) -> np.ndarray:
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", str(wav), "-map", "0:a:0",
         "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"],
        check=True, capture_output=True,
    )
    return np.frombuffer(result.stdout, dtype="<i2")


def labels(phones: list[Interval], frames: int) -> tuple[torch.Tensor, list[tuple[int, int, int]]]:
    times = (np.arange(frames) * FRAME_SAMPLES + FRAME_CENTER) / 16_000
    dense = torch.full((frames,), IGNORE, dtype=torch.long)
    spans = []
    for row in phones:
        _, actual, kind = annotation(row.label)
        # An omitted phone does not supervise an acoustic silence class.
        if actual is None or kind == "d":
            continue
        start, end = map(int, np.searchsorted(times, [row.start, row.end]))
        if start < end:
            index = PHONE_INDEX[actual]
            dense[start:end] = index
            spans.append((start, end, index))
    return dense, spans


def ctc_examples(spans: list[tuple[int, int, int]]) -> list[tuple[int, int, list[int]]]:
    examples = []
    start = end = 0
    sequence: list[int] = []
    for left, right, phone in spans:
        if sequence and (left != end or right - start > 200):
            examples.append((start, end, sequence))
            sequence = []
        if not sequence:
            start = left
        end = right
        sequence.append(phone)
    if sequence:
        examples.append((start, end, sequence))
    # Adjacent identical labels need a separating CTC blank.
    return [(start, end, values) for start, end, values in examples
            if end - start >= len(values) + sum(a == b for a, b in zip(values, values[1:]))]


def loss_for_clip(probe, features, dense, spans, weights):
    frame, ctc, boundary = probe(features)
    frame_loss = F.cross_entropy(frame, dense, weight=weights, ignore_index=IGNORE)
    valid = (dense[1:] != IGNORE) & (dense[:-1] != IGNORE)
    edges = torch.zeros(len(dense), dtype=torch.bool)
    edges[[start for start, _, _ in spans]] = True
    boundary_loss = F.binary_cross_entropy_with_logits(
        boundary[1:][valid], edges[1:][valid].float(), pos_weight=torch.tensor(2.0),
    )
    examples = ctc_examples(spans)
    sequences = [torch.tensor(phones) for _, _, phones in examples]
    if not sequences:
        raise ValueError("training clip has no valid CTC spans")
    emissions = torch.nn.utils.rnn.pad_sequence([ctc[start:end] for start, end, _ in examples])
    ctc_loss = F.ctc_loss(
        emissions.log_softmax(-1), torch.cat(sequences), torch.tensor([end - start for start, end, _ in examples]),
        torch.tensor([len(sequence) for sequence in sequences]), blank=BLANK,
    )
    return frame_loss + 0.25 * ctc_loss + 0.2 * boundary_loss


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("encoder", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--epochs", type=int, default=22)
    args = parser.parse_args()
    if args.threads < 1 or args.epochs < 1:
        parser.error("threads and epochs must be positive")
    if sha256(args.archive) != PUBLISHER_SHA256:
        parser.error("archive differs from the fixed publisher version")
    if args.output.exists():
        parser.error("output directory already exists")

    torch.set_num_threads(args.threads)
    torch.manual_seed(29)
    order = random.Random(29)
    started = perf_counter()
    encoder = load_encoder(args.encoder)
    clips, sources = [], []
    distribution: Counter[int] = Counter()
    with ZipFile(args.archive) as archive, TemporaryDirectory(prefix="bandroom-probe-") as temp:
        names = sorted(Path(name).stem for name in archive.namelist() if name.endswith(".TextGrid"))
        for name in names:
            if name in EVALUATION | CALIBRATION:
                continue
            annotation_bytes = archive.read(f"suitcase_corpus/annotation/{name}.TextGrid")
            wav = Path(temp) / "training.wav"
            wav.write_bytes(archive.read(f"suitcase_corpus/wav/{name}.wav"))
            pcm = decode(wav, args.ffmpeg)
            features, input_samples = encode(encoder, pcm)
            dense, spans = labels(tiers(annotation_bytes.decode("utf-8-sig"))["phones"], len(features))
            distribution.update(dense[dense != IGNORE].tolist())
            clips.append((features, dense, spans))
            sources.append({"clipId": name, "audioSha256": sha256(wav), "samples": len(pcm),
                            "encodedSamples": input_samples, "supervisedFrames": int((dense != IGNORE).sum())})
            print(f"encoded {name}: {len(features)} frames", flush=True)

    if not clips:
        raise ValueError("no development training clips")
    total = sum(distribution.values())
    weights = torch.tensor([max(0.45, min(3.0, (total / len(PHONES) / max(1, distribution[i])) ** 0.35))
                            for i in range(len(PHONES))], dtype=torch.float32)
    probe = PhoneProbe()
    optimizer = torch.optim.AdamW(probe.parameters(), lr=0.002, weight_decay=0.01)
    losses = []
    for epoch in range(args.epochs):
        order.shuffle(clips)
        values = []
        for features, dense, spans in clips:
            optimizer.zero_grad(set_to_none=True)
            loss = loss_for_clip(probe, features, dense, spans, weights)
            if not bool(loss.isfinite()):
                raise ValueError("training loss is not finite")
            loss.backward()
            optimizer.step()
            values.append(float(loss.detach()))
        losses.append(sum(values) / len(values))
        print(f"epoch {epoch + 1}: {losses[-1]:.4f}", flush=True)

    args.output.mkdir(parents=True, exist_ok=False)
    weights_path = args.output / "probe.safetensors"
    save_file(probe.state_dict(), weights_path)
    manifest = {
        "developmentOnly": True, "publisherArchiveSha256": PUBLISHER_SHA256,
        "encoderSha256": ENCODER_SHA256, "probeSha256": sha256(weights_path),
        "sources": sources, "excludedDevelopmentClips": sorted(EVALUATION),
        "excludedCalibrationClips": sorted(CALIBRATION), "seed": 29, "threads": args.threads,
        "lossByEpoch": losses, "seconds": perf_counter() - started,
    }
    (args.output / "training.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
