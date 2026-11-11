"""Sample-exact chunk planning with overlap and complete-tail coverage."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .decode import TARGET_RATE


@dataclass(frozen=True)
class Chunk:
    index: int
    start_sample: int
    end_sample: int
    valid_samples: int
    overlap_before: int
    overlap_after: int

    def as_dict(self) -> dict:
        return asdict(self)


def plan_chunks(sample_count: int, *, window_seconds: float = 20.0,
                overlap_seconds: float = 2.0, sample_rate: int = TARGET_RATE) -> list[Chunk]:
    if sample_count <= 0:
        raise ValueError("sample_count must be positive")
    if window_seconds <= 0 or overlap_seconds < 0 or overlap_seconds >= window_seconds:
        raise ValueError("require window_seconds > overlap_seconds >= 0")
    window = max(1, int(round(window_seconds * sample_rate)))
    overlap = int(round(overlap_seconds * sample_rate))
    step = max(1, window - overlap)
    starts: list[int] = []
    start = 0
    while True:
        starts.append(start)
        if start + window >= sample_count:
            break
        start += step
    chunks: list[Chunk] = []
    for index, start in enumerate(starts):
        end = min(start + window, sample_count)
        chunks.append(Chunk(
            index=index, start_sample=start, end_sample=end, valid_samples=end - start,
            overlap_before=max(0, start - max(0, start - overlap)),
            overlap_after=max(0, min(sample_count, end + overlap) - end),
        ))
    if chunks[0].start_sample != 0 or chunks[-1].end_sample != sample_count:
        raise ValueError("chunk plan does not start at 0 or end at the last sample")
    for previous, current in zip(chunks, chunks[1:]):
        if current.start_sample > previous.end_sample:
            raise ValueError("chunk plan contains a coverage gap")
    return chunks


def chunk_coverage(chunks: list[Chunk], sample_count: int) -> list[list[int]]:
    if not chunks:
        return []
    ranges: list[list[int]] = []
    for chunk in chunks:
        if not ranges or chunk.start_sample > ranges[-1][1]:
            ranges.append([chunk.start_sample, chunk.end_sample])
        else:
            ranges[-1][1] = max(ranges[-1][1], chunk.end_sample)
    if ranges[0][0] != 0 or ranges[-1][1] != sample_count:
        raise ValueError("chunk coverage is incomplete")
    return ranges
