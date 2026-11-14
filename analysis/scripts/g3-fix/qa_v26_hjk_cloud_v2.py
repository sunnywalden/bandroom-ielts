#!/usr/bin/env python3
"""qa_v26_hjk_cloud_v2.py — generalized, future-version probe runner.

The accepted/frozen runner ``official-hjk-v26/qa_v26_hjk_cloud.py`` is left
byte-untouched (design BL2).  This v2 runner is a NEW versioned artifact for
future runs only.  It differs from the frozen original in four deliberate ways:

1. Sample/window counts are DERIVED from the decoded fixture
   (``derive_counts`` / ``derive_counts_from_pcm``).  Nothing is pinned to the
   HJK reference values 1,099,196 samples / 859 windows.
2. AAC canonicalization lives in the DECODE layer.  ``ffprobe`` supplies the
   integer stream duration (``duration_ts``, falling back to
   ``last_pts + duration``), then ``ffmpeg -af atrim=end_sample=N`` produces the
   canonical PCM.  The canonical bytes MUST equal the byte prefix of the
   untrimmed decode, for both f32le and s16le.
3. An eight-stage instrumentation ledger
   (download/prepare/decode/asr/acoustic/candidates/validate/writeback) is
   recorded.  The acoustic-only QA runtime does not execute ASR or candidate
   generation, so those two stages are explicitly ``status="absent"`` with
   ``seconds=None`` and ``value=None``.  They are NEVER zero or a fabricated
   positive value.
4. Processor and ``sourceLimitObservation`` are recorded, and a QA
   ``budgetProfile`` is supported.  ``fullTask`` stays ``None`` until the V4
   cloud measurement supplies the owner-approved value (D-3c); it is never
   silently treated as zero.

The module is importable and unit-testable without cloud access and without
``onnxruntime``.  ``onnxruntime`` is imported lazily inside the inference
functions only.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import struct
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np

RECIPE = "9022a23414fc0201753c3a06e81209d058c9ae0fbe5c6dff5893042e909e95c2"
ENCODER = "913f30b95735bbf2e7d80dc93066e2730dc02bd0d19fb4a6b7cfefab657ed07c"
HEAD = "813c832bebffb68087be08544a1be100c1e73dda6f431d7a4731084e22430370"
RECORDING = "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1"
JOB = "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710"
TASK = "Automation_7b08ddcb7e548191b65cf99c01d8c1ca"
CONFIG = {
    "mode": "diagnostic", "sampleRateHz": 16000, "frameSamples": 320,
    "receptiveSamples": 400, "windowFrames": 800, "contextFrames": 100,
    "offsets": [0, 400], "features": 768,
}

PROBE_BLOB_MAX_READ_BYTES = 4_194_304
PTYL_LINE_MAX_CHARS = 3000
COLD_UPPER_BOUND_SAMPLES = 2_880_000  # 180 s at 16 kHz; design MJ7/B-m9

STAGES = ("download", "prepare", "decode", "asr", "acoustic",
          "candidates", "validate", "writeback")
ABSENT_STAGES = ("asr", "candidates")
ABSENT_STAGE_REASON = (
    "acoustic-only QA runtime: stage is not executed by this runner; "
    "value is absent (null), not zero and not fabricated"
)

BUDGET_PROFILES = {
    "qa-runtime": {
        "coldDeliveryInstall": 1100,
        "fullTask": None,
        "fullTaskSource": "pending V4 cloud measurement (owner D-3c); null is a placeholder, not zero",
        "scope": "acoustic/transport subset: download/prepare/decode/acoustic/validate/writeback",
        "asrCandidatesStage": "absent in QA runtime; full pipeline deferred to formal G5 (D-3b)",
    },
}

_FORMAT_BYTES = {"f32le": 4, "s16le": 2, "f64le": 8}


# ---------------------------------------------------------------------------
# hashing / canonical JSON
# ---------------------------------------------------------------------------
def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def file_sha(path) -> str:
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


# ---------------------------------------------------------------------------
# generalized counts (never hard-coded to the HJK fixture)
# ---------------------------------------------------------------------------
def probe_window_count(sample_count: int, receptive_samples: int = 1920,
                       stride_samples: int = 1280) -> int:
    """Window count used by the v26 probe head (identical formula to frozen runner)."""
    _require(sample_count > 0, "sample count must be positive")
    return (max(0, sample_count - receptive_samples) + stride_samples - 1) // stride_samples + 1


def plan_total_windows(sample_count: int, receptive_samples: int = 400,
                       frame_samples: int = 320) -> int:
    """Total acoustic-plan windows (identical formula to verify_official_run_v26)."""
    total = (sample_count - receptive_samples) // frame_samples + 1
    _require(total >= 1, "acoustic plan needs at least 25 ms of PCM")
    return total


def plan_chunk_count(total_windows: int, window_frames: int = 800,
                     offsets=(0, 400)) -> int:
    """Number of acoustic-NN chunks for a generalized fixture."""
    count = 0
    for offset in offsets:
        first = offset - window_frames if offset else 0
        count += len(range(first, total_windows, window_frames))
    return count


def derive_counts(sample_count: int) -> dict:
    """Derive every expected count from a decoded fixture's sample count."""
    total = plan_total_windows(sample_count)
    return {
        "sampleCount": int(sample_count),
        "durationSeconds": sample_count / 16000.0,
        "probeWindows": probe_window_count(sample_count),
        "planTotalWindows": total,
        "planChunks": plan_chunk_count(total),
        "countSource": "derived from decoded fixture sample count",
    }


def derive_counts_from_pcm(pcm_path, dtype: str = "<f4") -> dict:
    """Derive expected counts from a decoded PCM file without loading it."""
    size = Path(pcm_path).stat().st_size
    itemsize = np.dtype(dtype).itemsize
    _require(size > 0 and size % itemsize == 0,
             f"PCM size {size} is not a positive multiple of {itemsize}")
    return derive_counts(size // itemsize)


# ---------------------------------------------------------------------------
# DECODE layer: ffprobe integer duration -> ffmpeg atrim -> prefix assertion
# ---------------------------------------------------------------------------
def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, check=False)


def ffprobe_audio_metadata(source) -> dict:
    """Read integer container timing from ffprobe (no floating-point rounding)."""
    source = str(source)
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,time_base,duration_ts,duration,start_pts:"
        "packet=pts,dts,duration",
        "-of", "json", source,
    ]
    proc = _run(cmd)
    _require(proc.returncode == 0,
             f"ffprobe failed ({proc.returncode}): {proc.stderr.decode(errors='replace')}")
    payload = json.loads(proc.stdout.decode())
    streams = payload.get("streams") or []
    _require(len(streams) == 1, f"expected exactly one audio stream, found {len(streams)}")
    stream = streams[0]
    time_base = stream.get("time_base") or "1/1"
    packets = payload.get("packets") or []
    last = max(packets, key=lambda row: row.get("pts", -10 ** 18)) if packets else {}
    first = min(packets, key=lambda row: row.get("pts", 10 ** 18)) if packets else {}

    duration_ts = stream.get("duration_ts")
    duration_ts = int(duration_ts) if duration_ts is not None else None
    sample_rate = int(stream.get("sample_rate") or 16000)
    codec = stream.get("codec_name")

    meta = {
        "source": source,
        "codec": codec,
        "sampleRate": sample_rate,
        "channels": int(stream.get("channels") or 1),
        "timeBase": time_base,
        "durationTs": duration_ts,
        "durationSeconds": float(stream["duration"]) if stream.get("duration") is not None else None,
        "startPts": int(stream["start_pts"]) if stream.get("start_pts") is not None else None,
        "packetCount": len(packets),
        "firstPacketPts": int(first["pts"]) if first.get("pts") is not None else None,
        "firstPacketDuration": int(first["duration"]) if first.get("duration") is not None else None,
        "lastPacketPts": int(last["pts"]) if last.get("pts") is not None else None,
        "lastPacketDuration": int(last["duration"]) if last.get("duration") is not None else None,
    }
    count, count_source = canonical_sample_count(meta)
    meta["canonicalSampleCount"] = count
    meta["canonicalSampleCountSource"] = count_source
    # Observation only: how many trailing AAC frame samples sit beyond the
    # container duration.  For HJK this is 580 (1099776 raw - 1099196).
    if codec == "aac" and meta["lastPacketPts"] is not None and duration_ts:
        frame = 1024
        padding = meta["lastPacketPts"] + frame - duration_ts
        meta["tailPaddingObservation"] = padding if padding > 0 else 0
        meta["tailPaddingObservationBasis"] = "last_packet_pts + 1024 - duration_ts"
    return meta


def canonical_sample_count(meta: dict) -> tuple[int, str]:
    """Return (N, source): duration_ts, else last_pts+duration, else duration*sr."""
    duration_ts = meta.get("durationTs")
    if isinstance(duration_ts, int) and duration_ts > 0:
        return duration_ts, "duration_ts"
    if meta.get("lastPacketPts") is not None and meta.get("lastPacketDuration") is not None:
        total = int(meta["lastPacketPts"]) + int(meta["lastPacketDuration"])
        if total > 0:
            return total, "last_pts_plus_duration"
    if meta.get("durationSeconds") is not None and meta.get("sampleRate"):
        return int(round(float(meta["durationSeconds"]) * int(meta["sampleRate"]))), "duration_seconds"
    raise ValueError("cannot derive an integer sample count from ffprobe metadata")


def ffmpeg_decode(source, fmt: str = "f32le", atrim_end_sample: int | None = None,
                  sample_rate: int = 16000, channels: int = 1,
                  input_args: tuple[str, ...] = ()) -> bytes:
    """Decode one audio stream to interleaved PCM; optional canonical atrim."""
    _require(fmt in _FORMAT_BYTES, f"unsupported PCM format {fmt}")
    cmd = ["ffmpeg", "-v", "error", "-nostdin", *input_args, "-i", str(source),
           "-map", "0:a:0"]
    if atrim_end_sample is not None:
        _require(int(atrim_end_sample) > 0, "atrim end_sample must be positive")
        cmd += ["-af", f"atrim=end_sample={int(atrim_end_sample)}"]
    cmd += ["-ac", str(channels), "-ar", str(sample_rate), "-f", fmt, "pipe:1"]
    proc = _run(cmd)
    _require(proc.returncode == 0,
             f"ffmpeg decode failed ({proc.returncode}): {proc.stderr.decode(errors='replace')}")
    return proc.stdout


def assert_canonical_prefix(canonical_bytes: bytes, raw_bytes: bytes, fmt: str) -> dict:
    """Canonical PCM must be a whole-sample byte prefix of the raw decode."""
    bps = _FORMAT_BYTES[fmt]
    _require(len(canonical_bytes) % bps == 0,
             f"{fmt} canonical length {len(canonical_bytes)} is not a whole sample")
    _require(len(raw_bytes) % bps == 0,
             f"{fmt} raw length {len(raw_bytes)} is not a whole sample")
    _require(len(canonical_bytes) <= len(raw_bytes),
             f"{fmt} canonical ({len(canonical_bytes)} B) exceeds raw ({len(raw_bytes)} B)")
    _require(canonical_bytes == raw_bytes[:len(canonical_bytes)],
             f"{fmt} canonical bytes are not a prefix of the raw decode")
    return {
        "format": fmt,
        "rawSamples": len(raw_bytes) // bps,
        "canonicalSamples": len(canonical_bytes) // bps,
        "prefixEqual": True,
    }


def reproduce_untrimmed_pcm(source, fmt: str, meta: dict | None = None) -> dict:
    """Decode WITHOUT ffmpeg's automatic skip-samples trimming.

    ``-flags2 +skip_manual`` retains AAC priming/tail padding.  The leading
    priming samples (``-first_pts``) are removed arithmetically so the result
    reproduces the pre-canonical raw sample stream (1099776 for HJK).  This is
    an observation/reproduction helper; canonicalization itself always uses
    ``atrim=end_sample=N`` from ffprobe.
    """
    meta = meta or ffprobe_audio_metadata(source)
    bps = _FORMAT_BYTES[fmt]
    raw = ffmpeg_decode(source, fmt=fmt, input_args=("-flags2", "+skip_manual"))
    prime = abs(min(0, meta.get("firstPacketPts") or 0))
    body = raw[prime * bps:]
    return {
        "format": fmt,
        "primingSamplesRemoved": prime,
        "samples": len(body) // bps,
        "body": body,
        "bodySha256": sha(body),
    }


def canonicalize_aac(source, formats=("f32le", "s16le"), work=None) -> dict:
    """Full decode-layer canonicalization with prefix equality for every format."""
    meta = ffprobe_audio_metadata(source)
    n = meta["canonicalSampleCount"]
    result = {
        "schema": "bandroom.qa.decode-canonicalization.v2",
        "source": str(source),
        "sourceSha256": file_sha(source),
        "ffprobe": meta,
        "canonicalSampleCount": n,
        "counts": derive_counts(n),
        "formats": {},
    }
    for fmt in formats:
        raw = ffmpeg_decode(source, fmt=fmt)
        canonical_bytes = ffmpeg_decode(source, fmt=fmt, atrim_end_sample=n)
        check = assert_canonical_prefix(canonical_bytes, raw, fmt)
        entry = {
            **check,
            "rawBytes": len(raw),
            "rawSha256": sha(raw),
            "canonicalBytes": len(canonical_bytes),
            "canonicalSha256": sha(canonical_bytes),
        }
        if work is not None:
            work = Path(work)
            work.mkdir(parents=True, exist_ok=True)
            raw_path = work / f"raw.{fmt}"
            canonical_path = work / f"canonical.{fmt}"
            raw_path.write_bytes(raw)
            canonical_path.write_bytes(canonical_bytes)
            entry["rawPath"] = str(raw_path)
            entry["canonicalPath"] = str(canonical_path)
        result["formats"][fmt] = entry
    return result


# ---------------------------------------------------------------------------
# eight-stage instrumentation ledger
# ---------------------------------------------------------------------------
def build_stage_ledger() -> dict:
    ledger = {}
    for name in STAGES:
        if name in ABSENT_STAGES:
            ledger[name] = {
                "status": "absent",
                "seconds": None,
                "value": None,
                "absentReason": ABSENT_STAGE_REASON,
            }
        else:
            ledger[name] = {
                "status": "not_run",
                "seconds": None,
                "value": None,
                "absentReason": "stage not executed in this run",
            }
    return ledger


def validate_stage_ledger(ledger: dict) -> None:
    """Enforce honest semantics: absent stages are null/absent, never zero."""
    _require(set(ledger) == set(STAGES),
             f"stage ledger keys must be exactly {STAGES}, got {sorted(ledger)}")
    for name in ABSENT_STAGES:
        stage = ledger[name]
        _require(stage.get("status") == "absent",
                 f"stage {name} must be status=absent in the acoustic-only QA runtime")
        _require(stage.get("seconds") is None and stage.get("value") is None,
                 f"stage {name} must not carry seconds/value; absence is null, not zero")
        _require(isinstance(stage.get("absentReason"), str) and stage["absentReason"],
                 f"stage {name} must document why it is absent")
    for name, stage in ledger.items():
        if name in ABSENT_STAGES:
            continue
        _require(stage.get("status") in {"not_run", "ok", "failed"},
                 f"stage {name} has invalid status {stage.get('status')!r}")
        if stage["status"] == "ok":
            _require(isinstance(stage.get("seconds"), (int, float)) and stage["seconds"] >= 0,
                     f"stage {name} is ok but lacks a measured seconds value")
        elif stage["status"] == "failed":
            _require(stage.get("seconds") is None or
                     (isinstance(stage.get("seconds"), (int, float)) and stage["seconds"] >= 0),
                     f"stage {name} failed with an invalid elapsed value")
        else:
            _require(stage.get("seconds") is None,
                     f"stage {name} is not_run but carries seconds")


class StageLedger:
    """Mutable ledger with a context manager that measures elapsed time."""

    def __init__(self):
        self.document = build_stage_ledger()

    def mark_not_run(self, name: str, reason: str) -> None:
        self._guard(name)
        self.document[name] = {
            "status": "not_run", "seconds": None, "value": None, "absentReason": reason,
        }

    def mark_failed(self, name: str, reason: str, seconds: float | None = None) -> None:
        self._guard(name)
        self.document[name] = {
            "status": "failed", "seconds": seconds, "value": None, "absentReason": reason,
        }

    def record(self, name: str, seconds: float, value=None) -> None:
        self._guard(name)
        _require(seconds is not None and seconds >= 0, f"stage {name} needs measured seconds")
        self.document[name] = {
            "status": "ok", "seconds": round(float(seconds), 6),
            "value": value, "absentReason": None,
        }

    @contextmanager
    def timed(self, name: str):
        self._guard(name)
        start = time.monotonic()
        box: dict = {}
        try:
            yield box
        except Exception:
            self.mark_failed(name, "stage raised", time.monotonic() - start)
            raise
        self.record(name, time.monotonic() - start, value=box.get("value"))

    def snapshot(self) -> dict:
        validate_stage_ledger(self.document)
        return copy.deepcopy(self.document)

    @staticmethod
    def _guard(name: str) -> None:
        _require(name in STAGES, f"unknown stage {name!r}")
        _require(name not in ABSENT_STAGES,
                 f"stage {name} is absent in the acoustic-only QA runtime and cannot be recorded")


# ---------------------------------------------------------------------------
# processor / source limits / budget
# ---------------------------------------------------------------------------
def record_processor() -> dict:
    """Record what the platform exposes; never invent a CPU model."""
    cpu_model = None
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        try:
            for line in cpuinfo.read_text(errors="replace").splitlines():
                if line.lower().startswith("model name"):
                    cpu_model = line.split(":", 1)[1].strip()
                    break
        except OSError:
            cpu_model = None
    return {
        "machine": platform.machine() or None,
        "processor": platform.processor() or None,
        "cpuModel": cpu_model,
        "cpuCount": os.cpu_count(),
        "system": platform.system() or None,
        "python": platform.python_version(),
        "note": "observed values; null when the platform does not expose a value",
    }


def source_limit_observation(sample_count: int, recording_bytes: int | None = None) -> dict:
    _require(sample_count > 0, "sample count must be positive")
    return {
        "fixtureSampleCount": int(sample_count),
        "coldUpperBoundSamples": COLD_UPPER_BOUND_SAMPLES,
        "underColdUpperBound": sample_count < COLD_UPPER_BOUND_SAMPLES,
        "recordingBytes": recording_bytes,
        "probeBlobMaxReadBytes": PROBE_BLOB_MAX_READ_BYTES,
        "withinProbeBlobReadLimit":
            None if recording_bytes is None else recording_bytes <= PROBE_BLOB_MAX_READ_BYTES,
        "ptylLineMaxChars": PTYL_LINE_MAX_CHARS,
        "note": "observation of source/size limits only; not a delivery or timing measurement",
    }


def budget_profile(name: str = "qa-runtime") -> dict:
    _require(name in BUDGET_PROFILES, f"unknown budget profile {name!r}")
    profile = copy.deepcopy(BUDGET_PROFILES[name])
    validate_budget_profile(profile)
    return profile


def validate_budget_profile(profile: dict) -> None:
    install = profile.get("coldDeliveryInstall")
    _require(install == 1100, "coldDeliveryInstall must be the adopted 1100 s value")
    full = profile.get("fullTask")
    _require(full is None or (isinstance(full, (int, float)) and full > 0),
             "fullTask must be null (pending V4) or a positive measured value; never zero")
    if full is None:
        _require(isinstance(profile.get("fullTaskSource"), str) and profile["fullTaskSource"],
                 "a null fullTask must document that it is pending V4 measurement")


# ---------------------------------------------------------------------------
# acoustic inference (lazy onnxruntime; unchanged math, generalized counts)
# ---------------------------------------------------------------------------
def _ort():
    import onnxruntime as ort  # noqa: PLC0415 - deliberately lazy
    return ort


def prefix_chunk(index, previous, pcm_sha, raw):
    return envelope({
        "format": "bandroom-acoustic-chunk-v1", "chunkIndex": index,
        "previousSha256": previous, "pcmSha256": pcm_sha, "configSha256": RECIPE,
        "featuresSha256": sha(raw),
    }, raw)


def envelope(header, payload):
    encoded = canonical(header)
    return struct.pack(">I", len(encoded)) + encoded + payload


def restore_prefix(blob, pcm_sha):
    _require(len(blob) == 125976, "v26 prefix blob must be exactly 125976 bytes")
    rows = []
    cursor, previous = 0, pcm_sha
    for index in range(8):
        head_size = struct.unpack_from(">I", blob, cursor)[0]
        _require(0 < head_size < 4096, "prefix chunk header is out of range")
        start = cursor + 4 + head_size
        end = start + 5 * 768 * 4
        raw = blob[start:end]
        chunk = blob[cursor:end]
        _require(len(raw) == 15360 and chunk == prefix_chunk(index, previous, pcm_sha, raw),
                 f"prefix chunk {index} failed integrity")
        rows.append(raw)
        cursor, previous = end, sha(chunk)
    _require(cursor == len(blob), "prefix blob has trailing bytes")
    return rows


def window_features(encoder, samples, index):
    sliced = samples[index * 1280:index * 1280 + 1920]
    padded = np.zeros((1, 1920), dtype=np.float32)
    padded[0, :len(sliced)] = sliced
    features = encoder.run(["features"], {"samples": padded})[0]
    _require(features.shape == (1, 5, 768), "encoder feature shape changed")
    _require(features.dtype == np.float32 and np.isfinite(features).all(),
             "encoder features are not finite f32")
    return features.astype("<f4", copy=False).tobytes()


def build_plan(total_windows: int) -> list[dict]:
    """Generalized acoustic plan; no assumption of exactly 10 chunks."""
    plan = []
    for offset in CONFIG["offsets"]:
        for first in range(offset - CONFIG["windowFrames"] if offset else 0,
                           total_windows, CONFIG["windowFrames"]):
            start, end = max(0, first), min(total_windows, first + CONFIG["windowFrames"])
            plan.append({
                "offset": offset, "start": start, "end": end,
                "left": max(0, start - CONFIG["contextFrames"]),
                "right": min(total_windows, end + CONFIG["contextFrames"]),
            })
    return plan


# ---------------------------------------------------------------------------
# phased execution
# ---------------------------------------------------------------------------
def _load_samples(pcm_path, dtype: str):
    samples = np.fromfile(pcm_path, dtype=dtype)
    _require(len(samples) > 0, "decoded fixture is empty")
    _require(np.isfinite(samples).all(), "decoded fixture contains non-finite samples")
    return samples


def run_decode(source, work, budget_name="qa-runtime") -> dict:
    """Decode-layer phase: canonicalize AAC, derive counts, record ledger."""
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    ledger = StageLedger()
    ledger.mark_not_run("download", "source fixture is already local; v2 does not fetch cloud bytes")
    ledger.mark_not_run("acoustic", "decode phase performs no inference")
    ledger.mark_not_run("validate", "decode phase relies on inline canonicalization assertions")
    ledger.mark_not_run("writeback", "decode phase writes decode.json outside the stage ledger")

    with ledger.timed("prepare") as prepare:
        meta = ffprobe_audio_metadata(source)
        prepare["value"] = {"durationTs": meta["durationTs"], "sampleRate": meta["sampleRate"],
                            "codec": meta["codec"]}

    with ledger.timed("decode") as decode:
        result = canonicalize_aac(source, work=work)
        decode["value"] = {
            "canonicalSampleCount": result["canonicalSampleCount"],
            "formats": sorted(result["formats"]),
        }

    # The un-trimmed reproduction is an observation, not an acceptance gate.
    reproduction = {}
    for fmt in ("f32le", "s16le"):
        try:
            reproduced = reproduce_untrimmed_pcm(source, fmt, meta)
            reproduction[fmt] = {
                "samples": reproduced["samples"],
                "bodySha256": reproduced["bodySha256"],
                "primingSamplesRemoved": reproduced["primingSamplesRemoved"],
            }
        except Exception as exc:  # pragma: no cover - build/version dependent
            reproduction[fmt] = {"status": "unavailable", "reason": str(exc)}

    result.update({
        "processor": record_processor(),
        "sourceLimitObservation": source_limit_observation(
            result["canonicalSampleCount"],
            recording_bytes=Path(source).stat().st_size),
        "budgetProfile": budget_profile(budget_name),
        "stageLedger": ledger.snapshot(),
        "untrimmedReproductionObservation": reproduction,
        "elapsedSeconds": None,
    })
    (work / "decode.json").write_bytes(canonical(result) + b"\n")
    return result


def run_probe(phase: str, assets, work, pcm_path, source=None,
              budget_name="qa-runtime", expected_samples=None) -> dict:
    """Probe/plan phase.  Counts derive from the fixture; nothing is pinned."""
    assets, work, pcm_path = Path(assets), Path(work), Path(pcm_path)
    work.mkdir(parents=True, exist_ok=True)
    _require(phase in ("prefix", "resume", "cold", "plan-prefix", "plan-resume", "plan-cold"),
             f"unknown probe phase {phase!r}")
    ort = _ort()
    started = time.monotonic()
    ledger = StageLedger()
    ledger.mark_not_run("download", "assets and fixture are supplied locally; no cloud delivery in this runner")

    dtype = "<i2" if phase.startswith("plan-") else "<f4"

    # Optional decode-layer canonicalization from the original container.
    if source is not None:
        with ledger.timed("decode") as decode:
            fmt = "s16le" if phase.startswith("plan-") else "f32le"
            decoded = canonicalize_aac(source, formats=(fmt,), work=work)
            pcm_path = work / f"canonical.{fmt}"
            decode["value"] = {"format": fmt,
                               "canonicalSampleCount": decoded["canonicalSampleCount"]}
    else:
        ledger.mark_not_run("decode", "PCM supplied pre-decoded; use the decode phase for AAC canonicalization")

    with ledger.timed("prepare") as prepare:
        samples = _load_samples(pcm_path, dtype)
        counts = derive_counts(len(samples))
        if expected_samples is not None:
            _require(int(expected_samples) == len(samples),
                     f"fixture has {len(samples)} samples, expected {expected_samples}")
        _require(_ort_version_matches(ort), "onnxruntime version is not the frozen 1.24.4")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        encoder = ort.InferenceSession(str(assets / "encoder-int8.onnx"), sess_options=options,
                                       providers=["CPUExecutionProvider"])
        _require(encoder.get_providers() == ["CPUExecutionProvider"],
                 "encoder provider is not CPUExecutionProvider")
        _require(file_sha(assets / "encoder-int8.onnx") == ENCODER, "encoder SHA mismatch")
        _require(file_sha(assets / "probe-head.onnx") == HEAD, "probe head SHA mismatch")
        prepare["value"] = {**counts, "provider": "CPUExecutionProvider"}

    if phase == "prefix":
        _require(counts["probeWindows"] >= 8, "prefix phase needs at least 8 windows")

    runtime = {
        "ort": ort.__version__, "onnxruntime": ort.__version__, "numpy": np.__version__,
        "python": platform.python_version(), "provider": "CPUExecutionProvider",
        "intraOpThreads": 2, "interOpThreads": 1,
        "machine": platform.machine(), "system": platform.system(),
    }

    if phase.startswith("plan-"):
        with ledger.timed("acoustic") as acoustic:
            result = plan_chunks(encoder, samples, work, runtime, phase)
            acoustic["value"] = {"planChunks": len(result["plan"]),
                                 "sampleCount": result["sampleCount"]}
        ledger.mark_not_run("validate", "plan phase validates chunk hashes inline")
        with ledger.timed("writeback") as writeback:
            (work / f"{phase}.json").write_bytes(canonical(result) + b"\n")
            writeback["value"] = {"path": f"{phase}.json"}
    else:
        windows = counts["probeWindows"]
        with ledger.timed("acoustic") as acoustic:
            rows = restore_prefix((work / "prefix.bin").read_bytes(), file_sha(pcm_path)) \
                if phase == "resume" else []
            first = len(rows)
            stop = min(8, windows) if phase == "prefix" else windows
            for group in range(first, stop, 8):
                for index in range(group, min(group + 8, stop)):
                    rows.append(window_features(encoder, samples, index))
            frames = windows * 5
            head = ort.InferenceSession(str(assets / "probe-head.onnx"), sess_options=options,
                                        providers=["CPUExecutionProvider"])
            _require(head.get_providers() == ["CPUExecutionProvider"],
                     "probe head provider is not CPUExecutionProvider")
            raw_features = b"".join(rows)
            features = np.frombuffer(raw_features, dtype="<f4").reshape(frames, 768)
            tensors = head.run(["frame", "ctc", "boundary"], {"features": features})
            _require([t.shape for t in tensors] == [(frames, 49), (frames, 50), (frames,)],
                     "probe head output shapes changed")
            _require(all(t.dtype == np.float32 and np.isfinite(t).all() for t in tensors),
                     "probe head output is not finite f32")
            output = b"".join(t.astype("<f4", copy=False).tobytes() for t in tensors)
            _require(len(output) == frames * 400, "output byte count is not frames*400")
            acoustic["value"] = {"windows": windows, "frames": frames,
                                 "outputBytes": len(output)}
        result = {
            "samples": len(samples), "windows": windows,
            "duration": len(samples) / 16000, "pcmSha256": file_sha(pcm_path),
            "firstWindow": first, "computedWindows": stop - first,
            "outputBytes": len(output), "outputSha256": sha(output),
            "featuresSha256": sha(raw_features), "frames": len(features), "finite": True,
        }
        with ledger.timed("validate") as validate:
            _require(len(samples) > 0 and windows == counts["probeWindows"], "window count drift")
            validate["value"] = {"windows": windows}
        with ledger.timed("writeback") as writeback:
            output_name = "resumed-output.f32le" if phase == "resume" else "cold-output.f32le"
            if phase == "prefix":
                previous, chunks = file_sha(pcm_path), []
                for index, raw in enumerate(rows):
                    chunk = prefix_chunk(index, previous, file_sha(pcm_path), raw)
                    chunks.append(chunk)
                    previous = sha(chunk)
                prefix = b"".join(chunks)
                _require(restore_prefix(prefix, file_sha(pcm_path)) == rows,
                         "prefix round-trip failed")
                (work / "prefix.bin").write_bytes(prefix)
                result.update(prefixBytes=len(prefix), prefixSha256=sha(prefix),
                              chunkSha256=[sha(row) for row in chunks])
            else:
                (work / output_name).write_bytes(output)
            (work / f"{phase}.json").write_bytes(canonical(result) + b"\n")
            writeback["value"] = {"phase": phase}

    result.update({
        "expected": counts,
        "runtime": runtime,
        "runnerSha256": file_sha(Path(__file__)),
        "processor": record_processor(),
        "sourceLimitObservation": source_limit_observation(
            len(samples), recording_bytes=Path(pcm_path).stat().st_size),
        "budgetProfile": budget_profile(budget_name),
        "stageLedger": ledger.snapshot(),
        "elapsedSeconds": round(time.monotonic() - started, 6),
    })
    return result


def _ort_version_matches(ort) -> bool:
    return ort.__version__ == "1.24.4"


def plan_chunks(encoder, samples, work, runtime, phase):
    total = plan_total_windows(len(samples))
    plan = build_plan(total)
    pcm_sha = sha(samples.tobytes())
    diagnostic_decode = envelope({
        "format": "bandroom-qa-diagnostic-decode-v1", "inputSha256": RECORDING,
        "inputBytes": 441322, "sampleCount": len(samples), "pcmSha256": pcm_sha,
        "encoding": "s16le", "rateHz": 16000, "channels": 1,
    }, samples.tobytes())
    identity = {
        "environment": "bandroom-isolated-qa-diagnostic", "taskId": TASK, "jobId": JOB,
        "inputSha256": RECORDING, "inputBytes": 441322, "decodeSha256": sha(diagnostic_decode),
        "bundleSha256": sha(canonical({"runtime": runtime, "encoder": ENCODER, "head": HEAD})),
        "configSha256": sha(canonical(CONFIG)),
    }
    chunks, transfer = [], []
    previous = identity["decodeSha256"]
    prefix_count = 6 if phase == "plan-resume" else 0
    stop = 6 if phase == "plan-prefix" else len(plan)
    if prefix_count:
        prior = json.loads((work / "plan-prefix.json").read_bytes())
        _require(prior["identity"] == identity and prior["plan"] == plan,
                 "plan-resume context differs from plan-prefix")
        _require(len(prior["transfer"]) == prefix_count and len(prior["chunks"]) == prefix_count,
                 "plan-resume prefix count mismatch")
    for index, row in enumerate(plan[:stop]):
        path = work / f"acoustic-{index:02d}.bin"
        left, right, start, end = (row[key] for key in ("left", "right", "start", "end"))
        if index < prefix_count:
            prior_blob = path.read_bytes()
            header_length = struct.unpack_from(">I", prior_blob)[0]
            _require(0 < header_length < 4096, "prior chunk header is out of range")
            raw = prior_blob[4 + header_length:]
        else:
            pcm = samples[left * 320:(right - 1) * 320 + 400].astype(np.float32) / np.float32(32768)
            features = encoder.run(["features"], {"samples": pcm[None]})[0]
            _require(features.shape == (1, right - left, 768), "plan feature shape changed")
            _require(features.dtype == np.float32 and np.isfinite(features).all(),
                     "plan features are not finite f32")
            raw = features[0, start - left:end - left].astype("<f4", copy=False).tobytes()
        _require(len(raw) == (end - start) * 768 * 4, "plan chunk byte count changed")
        digest = sha(raw)
        block = envelope({
            "format": "bandroom-acoustic-chunk-v1", "chunkIndex": index,
            "previousSha256": previous, "decodeSha256": identity["decodeSha256"],
            "bundleSha256": identity["bundleSha256"], "configSha256": identity["configSha256"],
            "featuresSha256": digest,
        }, raw)
        previous = sha(block)
        receipt = {"index": index, "bytes": len(raw), "sha256": digest,
                   "transferBytes": len(block)}
        if index < prefix_count:
            _require(block == prior_blob and previous == prior["transfer"][index]
                     and receipt == prior["chunks"][index],
                     "restored plan chunk differs from the persisted prefix")
        else:
            path.write_bytes(block)
        chunks.append(receipt)
        transfer.append(previous)
    _require(len(set(transfer)) == stop, "plan transfer chain has duplicates")
    (work / "diagnostic-decode.bin").write_bytes(diagnostic_decode)
    return {
        "formalG5Release": False, "identity": identity, "config": CONFIG, "plan": plan,
        "cut": 6, "chunks": chunks, "transfer": transfer,
        "restoredChunks": prefix_count, "computedChunks": stop - prefix_count,
        "sampleCount": len(samples), "pcmSha256": pcm_sha,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="generalized v26 probe runner (v2)")
    sub = parser.add_subparsers(dest="command", required=True)

    decode_cmd = sub.add_parser("decode", help="canonicalize AAC in the decode layer")
    decode_cmd.add_argument("--source", required=True)
    decode_cmd.add_argument("--work", required=True)
    decode_cmd.add_argument("--budget-profile", default="qa-runtime")

    probe_cmd = sub.add_parser("probe", help="run a probe/plan phase on decoded PCM")
    probe_cmd.add_argument("phase", choices=("prefix", "resume", "cold",
                                             "plan-prefix", "plan-resume", "plan-cold"))
    probe_cmd.add_argument("assets")
    probe_cmd.add_argument("work")
    probe_cmd.add_argument("pcm")
    probe_cmd.add_argument("--source", default=None)
    probe_cmd.add_argument("--expected-samples", type=int, default=None)
    probe_cmd.add_argument("--budget-profile", default="qa-runtime")

    args = parser.parse_args(argv)
    if args.command == "decode":
        result = run_decode(args.source, args.work, args.budget_profile)
    else:
        result = run_probe(args.phase, args.assets, args.work, args.pcm,
                           source=args.source, budget_name=args.budget_profile,
                           expected_samples=args.expected_samples)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())