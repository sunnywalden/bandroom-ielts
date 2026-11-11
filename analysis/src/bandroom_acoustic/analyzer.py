"""Acoustic analyzer contract.

A production analyzer must be a frozen, licensed package that emits only
evidence-backed errors. This base implementation is deliberately unavailable:
it never fabricates a pronunciation judgment from text, metadata or silence.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .chunks import Chunk
from .decode import DecodedAudio


@dataclass
class AnalysisOutcome:
    state: str
    reason: str | None
    errors: list[dict] = field(default_factory=list)
    words: list[dict] = field(default_factory=list)
    timing: dict | None = None
    limitations: list[str] = field(default_factory=list)


class UnavailableAnalyzer:
    """Honest placeholder used until a qualified acoustic model is frozen."""

    version = "unavailable"

    def analyze(self, decoded: DecodedAudio, chunks: list[Chunk]) -> AnalysisOutcome:
        del decoded, chunks
        return AnalysisOutcome(
            state="blocked",
            reason="qualified_analyzer_unavailable",
            limitations=[
                "No frozen acoustic model is configured in this bundle.",
                "No pronunciation error or timestamp is asserted.",
            ],
        )
