#!/usr/bin/env python3
"""Freeze development predictions from original audio without reading annotations."""

from __future__ import annotations

import argparse
from hashlib import sha256 as digest
import json
from importlib.metadata import version
from pathlib import Path
import platform
import re
import resource
import subprocess
from tempfile import TemporaryDirectory
from time import perf_counter
import wave

import cmudict
import numpy as np
from safetensors.torch import load_file
import torch

from development_probe import (
    BLANK, ENCODER_SHA256, FRAME_CENTER, FRAME_SAMPLES, PHONES,
    PhoneProbe, encode, load_encoder, phone_symbol, sha256,
)
from phone_graph import KINDS, Segment, capped_by_window, compact_events, verified_events, word_events
from train_suitcase_probe import decode


WHISPER_SHA256 = "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f"
WORD = re.compile(r"[a-z]+(?:['-][a-z]+)*")
DICTIONARY = cmudict.dict()


def tokens(text: str) -> list[str]:
    return WORD.findall(text.lower().replace("’", "'"))


def pronunciations(word: str) -> tuple[tuple[str, ...], ...]:
    variants = []
    for raw in DICTIONARY.get(word, ()):
        phones = tuple(phone_symbol(phone) for phone in raw)
        if phones and all(phones) and phones not in variants:
            variants.append(phones)
    return tuple(variants)


def recognize(binary: Path, weights: Path, pcm: np.ndarray, threads: int) -> tuple[list[dict], str]:
    with TemporaryDirectory(prefix="bandroom-probe-asr-") as temp:
        source = Path(temp) / "audio.wav"
        with wave.open(str(source), "wb") as handle:
            handle.setparams((1, 2, 16_000, 0, "NONE", "not compressed"))
            handle.writeframes(pcm.tobytes())
        output = Path(temp) / "asr"
        subprocess.run(
            [str(binary), "-m", str(weights), "-f", str(source), "-of", str(output),
             "-ml", "1", "-sow", "-ojf", "-t", str(threads), "-ng"],
            check=True, capture_output=True, timeout=600,
        )
        document = json.loads(output.with_suffix(".json").read_bytes())
    words = []
    duration = len(pcm) // 16
    for segment in document["transcription"]:
        recognized = tokens(segment["text"])
        if not recognized:
            continue
        # whisper.cpp emits subwords and punctuation with separate timestamps.
        # Use lexical token bounds only when the segment yields one word.
        offsets = segment["offsets"]
        start, end = offsets["from"], offsets["to"]
        lexical = [token["offsets"] for token in segment["tokens"]
                   if tokens(token["text"]) and token["offsets"]["to"] > token["offsets"]["from"] >= 0]
        if len(recognized) == 1 and lexical:
            start, end = lexical[0]["from"], lexical[-1]["to"]
        valid = 0 <= start < end <= duration and len(recognized) == 1
        for word in recognized:
            variants = pronunciations(word)
            words.append({"word": word, "startMs": start, "endMs": end,
                          "timed": valid, "phones": list(variants[0]) if variants else []})
    return words, document["systeminfo"]


def acoustic_segments(posterior, boundary, blank, start, end):
    # Each interval is on the canonical sample clock of the source recording.
    frame_ms = (np.arange(len(posterior)) * FRAME_SAMPLES + FRAME_CENTER) / 16
    first, stop = map(int, np.searchsorted(frame_ms, [start, end]))
    winners = posterior[first:stop].argmax(axis=1)
    if len(winners) == 0:
        return []
    smoothed = winners.copy()
    for index in range(1, len(winners) - 1):
        if winners[index - 1] == winners[index + 1] != winners[index]:
            if posterior[first + index, winners[index]] < 0.80:
                smoothed[index] = winners[index - 1]
    cuts = [0]
    for index in range(1, len(smoothed)):
        global_index = first + index
        changed = smoothed[index] != smoothed[index - 1]
        repeated = (index - cuts[-1] >= 3 and len(smoothed) - index >= 3
                    and boundary[global_index] >= 0.8 and blank[global_index - 1] >= 0.65
                    and smoothed[index] == smoothed[index + 1] == smoothed[index + 2])
        if changed or repeated:
            cuts.append(index)
    cuts.append(len(smoothed))

    rows = []
    for left, right in zip(cuts, cuts[1:]):
        if PHONES[smoothed[left]] == "SIL":
            continue
        first_frame, last_frame = first + left, first + right - 1
        lo = max(start, round(frame_ms[first_frame] - 10))
        hi = min(end, round(frame_ms[last_frame] + 10))
        support = posterior[first_frame:last_frame + 1].mean(axis=0)
        if lo < hi:
            rows.append(Segment(lo, hi, dict(zip(PHONES, map(float, support)))))
    return rows


def word_bounds(words, index, duration):
    word = words[index]
    start, end = word["startMs"], word["endMs"]
    # Inspect at most 80 ms either side and divide the inter-word gap once.
    before = words[index - 1] if index else None
    after = words[index + 1] if index + 1 < len(words) else None
    if before and before["timed"]:
        start = max(start - 80, (start + before["endMs"]) // 2)
    if after and after["timed"]:
        end = min(end + 80, (end + after["startMs"]) // 2)
    return max(0, start), min(duration, end)


@torch.inference_mode()
def acoustic_pass(encoder, probe, pcm, words, offset, args):
    features, processed = encode(encoder, pcm, offset)
    frame, ctc, edges = probe(features)
    acoustic = frame.softmax(-1)
    ctc = ctc.softmax(-1)
    posterior = (acoustic * 0.82 + ctc[:, :BLANK] * 0.18).numpy()
    boundary, blank = edges.sigmoid().numpy(), ctc[:, BLANK].numpy()
    candidates = []
    duration = len(pcm) // 16
    for index, word in enumerate(words):
        if not word["phones"] or not word["timed"]:
            continue
        start, end = word_bounds(words, index, duration)
        if start >= end:
            continue
        observed = acoustic_segments(posterior, boundary, blank, start, end)
        variants = pronunciations(word["word"])
        next_word = index + 1 if index + 1 < len(words) else None
        candidates.extend(word_events(
            variants[0], variants[1:], observed, index, next_word, start, end,
            top_substitutions=args.substitutions, top_additions=args.additions,
            addition_budget=args.addition_budget, beam=args.beam,
        ))
    raw = compact_events(candidates)
    rows, dropped = capped_by_window(raw, args.window_cap)
    return raw, rows, {"offsetFrames": offset, "encodedSamples": processed, "globalFrames": len(features),
                       "rawCandidates": len(raw), "prunedByWindowCap": dropped}


def run(source, encoder, probe, args, metadata):
    started = perf_counter()
    pcm = decode(source, args.ffmpeg)
    decoded = perf_counter()
    words, whisper_system = recognize(args.whisper_binary, args.whisper_weights, pcm, args.threads)
    asr = perf_counter()
    raw, first, first_stats = acoustic_pass(encoder, probe, pcm, words, 0, args)
    first_finished = perf_counter()
    _, second, second_stats = acoustic_pass(encoder, probe, pcm, words, 400, args)
    second_finished = perf_counter()
    verified = verified_events(first, second)
    elapsed = perf_counter()
    return {
        **metadata, "clipId": source.stem, "audioSha256": sha256(source),
        "pcmSha256": digest(pcm.tobytes()).hexdigest(), "sampleCount": len(pcm),
        "sampleRate": 16_000, "words": words, "beforeCap": raw,
        "beforeVerification": first, "candidates": verified,
        "acousticPasses": [first_stats, second_stats], "whisperSystem": whisper_system,
        "runtime": {
            "decodeSeconds": decoded - started, "asrSeconds": asr - decoded,
            "firstPassSeconds": first_finished - asr, "secondPassSeconds": second_finished - first_finished,
            "verificationSeconds": elapsed - second_finished, "totalSeconds": elapsed - started,
        },
    }


def peak_rss_bytes(who: int) -> int:
    # Darwin reports bytes. Linux reports KiB.
    peak = resource.getrusage(who).ru_maxrss
    return peak if platform.system() == "Darwin" else peak * 1024


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("encoder", "probe_dir", "whisper_binary", "whisper_weights", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("audio", nargs="+", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--substitutions", type=int, default=5)
    parser.add_argument("--additions", type=int, default=4)
    parser.add_argument("--addition-budget", type=int, default=2)
    parser.add_argument("--beam", type=float, default=4)
    parser.add_argument("--window-cap", type=int, default=512)
    args = parser.parse_args()
    if (not 1 <= args.threads <= 8 or not 1 <= args.substitutions < BLANK
            or not 1 <= args.additions < BLANK or not 1 <= args.addition_budget <= 3
            or not 0 < args.beam <= 8 or not 3 <= args.window_cap <= 1024):
        parser.error("settings exceed development search bounds")
    if len({path.stem for path in args.audio}) != len(args.audio):
        parser.error("audio filenames must have unique stems")

    started = perf_counter()
    torch.set_num_threads(args.threads)
    training = json.loads((args.probe_dir / "training.json").read_bytes())
    weights = args.probe_dir / "probe.safetensors"
    if (sha256(args.whisper_weights) != WHISPER_SHA256 or training["encoderSha256"] != ENCODER_SHA256
            or sha256(weights) != training["probeSha256"] or training["developmentOnly"] is not True):
        parser.error("development weights do not match the pinned artifacts")
    encoder = load_encoder(args.encoder)
    probe = PhoneProbe().eval()
    probe.load_state_dict(load_file(weights))
    metadata = {
        "developmentOnly": True, "encoderSha256": ENCODER_SHA256, "probeSha256": sha256(weights),
        "trainingManifestSha256": sha256(args.probe_dir / "training.json"),
        "whisperSha256": WHISPER_SHA256, "whisperBinarySha256": sha256(args.whisper_binary),
        "settings": {name: getattr(args, name) for name in (
            "threads", "substitutions", "additions", "addition_budget", "beam", "window_cap")},
        "environment": {"system": platform.system(), "machine": platform.machine(),
                        "python": platform.python_version(), "torch": version("torch"),
                        "transformers": version("transformers"), "cmudict": version("cmudict")},
        "modelLoadSeconds": perf_counter() - started,
    }
    args.output.mkdir(parents=True, exist_ok=False)
    for source in args.audio:
        result = run(source, encoder, probe, args, metadata)
        result["runtime"]["parentPeakRssBytes"] = peak_rss_bytes(resource.RUSAGE_SELF)
        result["runtime"]["childPeakRssBytes"] = peak_rss_bytes(resource.RUSAGE_CHILDREN)
        (args.output / f"{source.stem}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        )
        counts = {kind: sum(row["kind"] == kind for row in result["candidates"]) for kind in KINDS}
        print(f"{source.stem}: {len(result['words'])} words, {counts}, {result['runtime']['totalSeconds']:.2f}s",
              flush=True)


if __name__ == "__main__":
    main()
