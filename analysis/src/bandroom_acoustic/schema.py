"""Minimal analysis.json contract shared by the CLI and the server validator."""

from __future__ import annotations

from typing import Any


def validate_analysis(value: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if value.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    if not isinstance(value.get("analysisVersion"), str) or not value["analysisVersion"]:
        problems.append("analysisVersion is required")
    if not isinstance(value.get("inputSha256"), str) or len(value["inputSha256"]) != 64:
        problems.append("inputSha256 must be 64 hex characters")
    decoded = value.get("decoded")
    if not isinstance(decoded, dict):
        problems.append("decoded object is required")
    else:
        if decoded.get("sampleRateHz") != 16_000:
            problems.append("decoded.sampleRateHz must be 16000")
        if not isinstance(decoded.get("sampleCount"), int) or decoded["sampleCount"] <= 0:
            problems.append("decoded.sampleCount must be positive")
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
        for event in errors:
            if not isinstance(event, dict):
                problems.append("each error must be an object")
                continue
            if event.get("kind") not in ("substitution", "deletion", "addition"):
                problems.append("error kind is invalid")
            if event.get("kind") == "deletion":
                if not isinstance(event.get("anchorMs"), (int, float)):
                    problems.append("deletion needs anchorMs")
            elif not isinstance(event.get("startMs"), (int, float)) or not isinstance(event.get("endMs"), (int, float)):
                problems.append("substitution/addition needs startMs and endMs")
    return problems
