"""Single-task acoustic analysis entrypoint.

Exit codes:
  0  completed with a qualified analyzer
  3  blocked/failed (the task must keep the honest reason; never fabricate errors)
  2  invalid input or output contract
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

from .analyzer import UnavailableAnalyzer
from .checkpoint import encode_checkpoint, read_checkpoint
from .chunks import chunk_coverage, plan_chunks
from .decode import DecodeError, DecodedAudio, decode_audio
from .schema import validate_analysis


def build_analysis(audio: str, *, analysis_version: str, ffmpeg: str = "ffmpeg") -> dict:
    started = time.monotonic()
    decoded = decode_audio(audio, ffmpeg=ffmpeg)
    return analyze_decoded(decoded, analysis_version, (time.monotonic() - started) * 1000.0)


def check_duration(decoded: DecodedAudio) -> None:
    if decoded.container_duration_ms is not None:
        delta = abs(decoded.container_duration_ms - decoded.decoded_duration_ms)
        if delta > max(100.0, decoded.decoded_duration_ms * 0.05):
            raise DecodeError("container and decoded durations differ by more than 5%")


def analyze_decoded(decoded: DecodedAudio, analysis_version: str, decode_ms: float) -> dict:
    check_duration(decoded)
    started = time.monotonic()
    chunks = plan_chunks(decoded.sample_count)
    chunk_ms = (time.monotonic() - started) * 1000.0
    analyzer = UnavailableAnalyzer()
    outcome = analyzer.analyze(decoded, chunks)
    state = outcome.state
    reason = outcome.reason
    errors = outcome.errors
    words = outcome.words
    timing = outcome.timing
    limitations = list(outcome.limitations)
    if state == "completed" and not chunks:
        state, reason = "failed", "chunk_plan_empty"
    if decoded.priming_ms is None:
        limitations.append("AAC priming is not independently measured; compare containerDurationMs with decodedDurationMs.")
    return {
        "schemaVersion": 1,
        "analysisVersion": analysis_version,
        "inputSha256": decoded.input_sha256,
        "inputBytes": decoded.input_bytes,
        "decoded": {
            "sampleRateHz": decoded.sample_rate,
            "sampleCount": decoded.sample_count,
            "container": decoded.container,
            "codec": decoded.codec,
            "sourceRateHz": decoded.source_rate,
            "sourceChannels": decoded.source_channels,
            "containerDurationMs": decoded.container_duration_ms,
            "decodedDurationMs": decoded.decoded_duration_ms,
            "primingMs": decoded.priming_ms,
        },
        "coverage": {
            "effectiveSpeechSamples": [],
            "analyzedSamples": chunk_coverage(chunks, decoded.sample_count) if state == "completed" else [],
            "fraction": 1.0 if state == "completed" else 0.0,
        },
        "words": words,
        "errors": errors,
        "timing": timing,
        "state": state,
        "reason": reason,
        "pipeline": {
            "chunks": [chunk.as_dict() for chunk in chunks],
            "decodeMs": round(decode_ms, 3),
            "chunkMs": round(chunk_ms, 3),
        },
        "limitations": limitations,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--audio", type=Path)
    source.add_argument("--checkpoint", type=Path)
    parser.add_argument("--input-sha256", help="expected SHA-256 of the original audio")
    parser.add_argument("--checkpoint-sha256", help="expected SHA-256 of the committed checkpoint")
    parser.add_argument("--save-checkpoint", type=Path)
    parser.add_argument("--decode-only", action="store_true")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--analysis-version", default="bandroom-acoustic-dev")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"))
    parser.add_argument("--json", action="store_true", help="print the full analysis JSON")
    args = parser.parse_args(argv)
    if args.checkpoint and (not args.input_sha256 or not args.checkpoint_sha256 or args.save_checkpoint):
        parser.error("--checkpoint requires both SHA-256 values and disallows --save-checkpoint")
    if args.decode_only and not args.save_checkpoint:
        parser.error("--decode-only requires --save-checkpoint")
    if not args.decode_only and not args.out:
        parser.error("--out is required when running analysis")
    try:
        started = time.monotonic()
        if args.checkpoint:
            decoded = read_checkpoint(args.checkpoint, input_sha256=args.input_sha256,
                                      artifact_sha256=args.checkpoint_sha256, analysis_version=args.analysis_version)
        else:
            decoded = decode_audio(args.audio, ffmpeg=args.ffmpeg)
            if args.input_sha256 and decoded.input_sha256 != args.input_sha256:
                raise DecodeError("original audio digest does not match the expected input")
        decode_ms = (time.monotonic() - started) * 1000.0
        check_duration(decoded)
        if args.save_checkpoint:
            args.save_checkpoint.parent.mkdir(parents=True, exist_ok=True)
            artifact = encode_checkpoint(decoded, args.analysis_version)
            temp = args.save_checkpoint.with_suffix(args.save_checkpoint.suffix + ".tmp")
            temp.write_bytes(artifact)
            temp.replace(args.save_checkpoint)
        if args.decode_only:
            from hashlib import sha256
            print(json.dumps({
                "inputSha256": decoded.input_sha256, "artifactSha256": sha256(artifact).hexdigest(),
                "bytes": len(artifact), "analysisVersion": args.analysis_version, "stage": "decode",
            }))
            return 0
        value = analyze_decoded(decoded, args.analysis_version, decode_ms)
    except (DecodeError, OSError, ValueError) as exc:
        print(f"decode failed: {exc}", file=sys.stderr)
        return 2
    problems = validate_analysis(value)
    if problems:
        value["state"] = "failed"
        value["reason"] = "invalid_analysis"
        value["limitations"] = [*value.get("limitations", []), *problems]
        problems = validate_analysis(value)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(args.out)
    if args.json:
        print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
    else:
        print(json.dumps({"out": str(args.out), "state": value["state"], "reason": value.get("reason")}, ensure_ascii=False))
    if value["state"] != "completed" or problems:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
