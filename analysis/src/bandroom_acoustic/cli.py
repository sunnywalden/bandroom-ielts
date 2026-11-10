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
from .chunks import chunk_coverage, plan_chunks
from .decode import DecodeError, decode_audio
from .schema import validate_analysis


def build_analysis(audio: str, *, analysis_version: str, ffmpeg: str = "ffmpeg") -> dict:
    started = time.monotonic()
    decoded = decode_audio(audio, ffmpeg=ffmpeg)
    decode_ms = (time.monotonic() - started) * 1000.0
    if decoded.container_duration_ms is not None:
        delta = abs(decoded.container_duration_ms - decoded.decoded_duration_ms)
        if delta > max(100.0, decoded.decoded_duration_ms * 0.05):
            raise DecodeError("container and decoded durations differ by more than 5%")
    chunks = plan_chunks(decoded.sample_count)
    chunk_ms = (time.monotonic() - started) * 1000.0 - decode_ms
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
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--analysis-version", default="bandroom-acoustic-dev")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"))
    parser.add_argument("--json", action="store_true", help="print the full analysis JSON")
    args = parser.parse_args(argv)
    try:
        value = build_analysis(str(args.audio), analysis_version=args.analysis_version, ffmpeg=args.ffmpeg)
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
