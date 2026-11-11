"""Minimal analysis.json contract shared by the CLI and the server validator."""

from __future__ import annotations

from collections import defaultdict
from math import inf
from typing import Any


def is_index(value: Any) -> bool:
    return type(value) is int and 0 <= value <= (1 << 53) - 1


def is_number(value: Any) -> bool:
    return type(value) in (int, float) and -inf < value < inf


def validate_events(events: list, duration_ms: float) -> list[str]:
    problems = []
    identities = set()
    additions = defaultdict(list)
    if len(events) > 500:
        problems.append("too many error events")
    for index, event in enumerate(events):
        prefix = f"errors[{index}]"
        if not isinstance(event, dict):
            problems.append(f"{prefix} must be an object")
            continue
        kind, target, actual = (event.get(key) for key in ("kind", "target", "actual"))
        word, phone = (event.get(key) for key in ("wordIndex", "phoneIndex"))
        if kind not in ("substitution", "deletion", "addition"):
            problems.append(f"{prefix}.kind is invalid")
            continue
        if not is_index(word) or not is_index(phone):
            problems.append(f"{prefix} needs word and phone indexes")
            continue
        if not isinstance(target, str) or not target or not isinstance(actual, str) or not actual:
            problems.append(f"{prefix} needs target and actual phones")
            continue
        identity = (word, phone, kind, target, actual)
        occurrence = event.get("gapOccurrence", 0)
        if "gapOccurrence" in event and (kind != "addition" or not is_index(occurrence)):
            problems.append(f"{prefix}.gapOccurrence must be a nonnegative safe integer on an addition")
            continue
        if "probability" in event and (not is_number(event["probability"]) or not 0 <= event["probability"] <= 1):
            problems.append(f"{prefix}.probability must be within [0,1]")
        if kind == "deletion":
            anchor = event.get("anchorMs")
            if target == "∅" or actual != "∅":
                problems.append(f"{prefix} needs a target phone and ∅ actual for a deletion")
            if not is_number(anchor) or not 0 <= anchor <= duration_ms:
                problems.append(f"{prefix}.anchorMs is outside the recording")
        else:
            start, end = (event.get(key) for key in ("startMs", "endMs"))
            if actual == "∅" or target == actual or ((target == "∅") != (kind == "addition")):
                problems.append(f"{prefix} has invalid target or actual phones")
            if not is_number(start) or not is_number(end) or not 0 <= start < end <= duration_ms:
                problems.append(f"{prefix} has an invalid startMs/endMs")
            elif kind == "addition":
                additions[identity].append((start, end, occurrence, index))
        event_key = (*identity, occurrence) if kind == "addition" else identity
        if event_key in identities:
            problems.append(f"{prefix} duplicates an error identity")
        identities.add(event_key)
    for group in additions.values():
        ordered = sorted(group)
        for previous, current in zip(ordered, ordered[1:]):
            start, _, occurrence, index = current
            if start < previous[1] or occurrence <= previous[2]:
                problems.append(f"errors[{index}] overlaps or misorders an addition in the same gap")
    return problems


def validate_analysis(value: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if value.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    if not isinstance(value.get("analysisVersion"), str) or not value["analysisVersion"]:
        problems.append("analysisVersion is required")
    if not isinstance(value.get("inputSha256"), str) or len(value["inputSha256"]) != 64:
        problems.append("inputSha256 must be 64 hex characters")
    decoded = value.get("decoded")
    duration_ms = 0.0
    if not isinstance(decoded, dict):
        problems.append("decoded object is required")
    else:
        if decoded.get("sampleRateHz") != 16_000:
            problems.append("decoded.sampleRateHz must be 16000")
        if not is_index(decoded.get("sampleCount")) or decoded["sampleCount"] == 0:
            problems.append("decoded.sampleCount must be positive")
        else:
            duration_ms = decoded["sampleCount"] / 16
    if value.get("state") not in ("completed", "blocked", "failed"):
        problems.append("state must be completed, blocked or failed")
    coverage = value.get("coverage")
    if not isinstance(coverage, dict):
        problems.append("coverage object is required")
    else:
        analyzed = coverage.get("analyzedSamples")
        if not isinstance(analyzed, list):
            problems.append("coverage.analyzedSamples must be a list")
        if value.get("state") == "completed" and coverage.get("fraction") != 1:
            problems.append("completed analysis must cover the full decoded timeline")
    errors = value.get("errors")
    if not isinstance(errors, list):
        problems.append("errors must be a list")
    else:
        problems.extend(validate_events(errors, duration_ms))
    return problems
