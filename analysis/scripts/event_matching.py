"""One-to-one identity and time matching for acoustic development evidence."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from heapq import heappop, heappush
from math import inf


def event_identity(event: dict) -> tuple:
    return tuple(event[key] for key in ("wordIndex", "phoneIndex", "kind", "target", "actual"))


def timing_distance(left: dict, right: dict) -> float:
    keys = ("anchorMs",) if left["kind"] == "deletion" else ("startMs", "endMs")
    return max(abs(left[key] - right[key]) for key in keys)


def event_time(event: dict) -> float:
    return event["anchorMs"] if event["kind"] == "deletion" else event["startMs"]


def overlaps(left: dict, right: dict) -> bool:
    return left["startMs"] < right["endMs"] and right["startMs"] < left["endMs"]


@dataclass
class Edge:
    to: int
    back: int
    cost: int
    open: bool


def closest_pairs(left: list[dict], right: list[dict], tolerance_ms: float = inf) -> list[tuple[int, int]]:
    """Match as many pairs as possible, then minimize total time difference."""
    if not left or not right:
        return []
    if len(left) == 1 or len(right) == 1:
        distance, i, j = min((timing_distance(a, b), i, j)
                             for i, a in enumerate(left) for j, b in enumerate(right))
        return [(i, j)] if distance <= tolerance_ms else []

    first_right = len(left)
    source, sink = first_right + len(right), first_right + len(right) + 1
    graph = [[] for _ in range(sink + 1)]

    def connect(start, end, cost=0):
        forward = Edge(end, len(graph[end]), cost, True)
        graph[start].append(forward)
        graph[end].append(Edge(start, len(graph[start]) - 1, -cost, False))
        return forward

    for i in range(len(left)):
        connect(source, i)
    for j in range(len(right)):
        connect(first_right + j, sink)
    matches = {}
    for i, first in enumerate(left):
        for j, second in enumerate(right):
            distance = timing_distance(first, second)
            if distance <= tolerance_ms:
                matches[i, j] = connect(i, first_right + j, round(distance * 1000))

    potential = [0] * len(graph)
    while matches:
        distance = [inf] * len(graph)
        distance[source] = 0
        previous = [None] * len(graph)
        queue = [(0, source)]
        while queue:
            cost, start = heappop(queue)
            if cost != distance[start]:
                continue
            for edge in graph[start]:
                next_cost = cost + edge.cost + potential[start] - potential[edge.to]
                if edge.open and next_cost < distance[edge.to]:
                    distance[edge.to] = next_cost
                    previous[edge.to] = start, edge
                    heappush(queue, (next_cost, edge.to))
        if previous[sink] is None:
            break
        for index, cost in enumerate(distance):
            if cost != inf:
                potential[index] += cost
        end = sink
        while end != source:
            start, edge = previous[end]
            edge.open = False
            graph[end][edge.back].open = True
            end = start
    return sorted(pair for pair, edge in matches.items() if not edge.open)


def group_by_identity(rows: list[dict]) -> dict[tuple, list[dict]]:
    groups = defaultdict(list)
    for row in rows:
        key = event_identity(row)
        if all(field is not None for field in key):
            groups[key].append(row)
    return groups


def distinct_predictions(group: list[dict]) -> list[dict]:
    if group[0]["kind"] != "addition":
        return group[:1]
    distinct = []
    for event in sorted(group, key=lambda row: (-row.get("score", 0), event_time(row))):
        if all(not overlaps(event, other) for other in distinct):
            distinct.append(event)
    return distinct


def match_events(reference: list[dict], predictions: list[dict], tolerance_ms: int = 150) -> list[tuple[dict, dict, bool]]:
    """Predictions excluded from pairing still count toward the FP denominator."""
    expected = group_by_identity(reference)
    matches = []
    for key, group in group_by_identity(predictions).items():
        truth = expected.get(key, [])
        candidates = distinct_predictions(group)
        timed = closest_pairs(truth, candidates, tolerance_ms)
        matches.extend((truth[i], candidates[j], True) for i, j in timed)
        left_used, right_used = {i for i, _ in timed}, {j for _, j in timed}
        left = [row for i, row in enumerate(truth) if i not in left_used]
        right = [row for j, row in enumerate(candidates) if j not in right_used]
        matches.extend((left[i], right[j], False) for i, j in closest_pairs(left, right))
    return matches
