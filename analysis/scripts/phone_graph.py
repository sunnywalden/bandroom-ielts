"""Bounded edit paths over acoustically observed phone segments."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from math import inf, isfinite, log

from event_matching import closest_pairs, distinct_predictions, event_identity, event_time, group_by_identity


KINDS = ("substitution", "deletion", "addition")
EMPTY = "∅"


@dataclass(frozen=True)
class Segment:
    start: int
    end: int
    probabilities: dict[str, float]


@dataclass(frozen=True)
class Arc:
    phone: int
    segment: int
    next_phone: int
    next_segment: int
    cost: float
    kind: str | None = None
    target: str | None = None
    actual: str | None = None
    support: float = 0.0


def distance(left: tuple[str, ...], right: tuple[str, ...]) -> list[list[int]]:
    matrix = [list(range(len(right) + 1))]
    for i, first in enumerate(left, 1):
        row = [i]
        for j, second in enumerate(right, 1):
            row.append(min(row[-1] + 1, matrix[-1][j] + 1, matrix[-1][j - 1] + (first != second)))
        matrix.append(row)
    return matrix


def allowed_edits(canonical: tuple[str, ...], variants: tuple[tuple[str, ...], ...]) -> set[tuple]:
    """Suppress identities that occur on a minimum edit path to a legal variant."""
    edits = set()
    n = len(canonical)
    for variant in variants:
        m = len(variant)
        front = distance(canonical, variant)
        back = distance(canonical[::-1], variant[::-1])
        optimum = front[n][m]
        for i in range(n + 1):
            for j in range(m + 1):
                cost = front[i][j] + 1
                if i < n and cost + back[n - i - 1][m - j] == optimum:
                    edits.add((i, "deletion", canonical[i], EMPTY))
                if j < m and cost + back[n - i][m - j - 1] == optimum:
                    edits.add((i, "addition", EMPTY, variant[j]))
                if i < n and j < m and canonical[i] != variant[j] and cost + back[n - i - 1][m - j - 1] == optimum:
                    edits.add((i, "substitution", canonical[i], variant[j]))
    return edits


def arcs_from(canonical, observed, i, j, top_substitutions, top_additions):
    if i < len(canonical):
        target = canonical[i]
        yield Arc(i, j, i + 1, j, 2.65, "deletion", target, EMPTY)
        if j < len(observed):
            probabilities = observed[j].probabilities
            target_support = probabilities.get(target, 0.0)
            yield Arc(i, j, i + 1, j + 1, -log(max(0.002, target_support)))
            alternatives = [(p, support) for p, support in probabilities.items() if p not in (target, "SIL")]
            alternatives.sort(key=lambda pair: (-pair[1], pair[0]))
            for actual, support in alternatives[:top_substitutions]:
                yield Arc(i, j, i + 1, j + 1, 0.95 - log(max(0.002, support)),
                          "substitution", target, actual, support)
    if j < len(observed):
        probabilities = observed[j].probabilities
        alternatives = [(p, support) for p, support in probabilities.items() if p != "SIL"]
        alternatives.sort(key=lambda pair: (-pair[1], pair[0]))
        for actual, support in alternatives[:top_additions]:
            yield Arc(i, j, i, j + 1, 1.85 - log(max(0.002, support)), "addition", EMPTY, actual, support)
        # Weak or extra evidence can be ignored as an alignment artifact. This
        # edge is never emitted as an error and competes with every addition.
        yield Arc(i, j, i, j + 1, 3.0)


def compact_events(rows: list[dict]) -> list[dict]:
    result = []
    for identity, group in group_by_identity(rows).items():
        priority = sorted(group, key=lambda event: (-event["score"], event_time(event)))
        if identity[2] != "addition":
            result.append(priority[0])
            continue
        distinct = distinct_predictions(priority)
        result.extend({**event, "gapOccurrence": i} for i, event in enumerate(sorted(distinct, key=event_time)))
    return sorted(result, key=lambda event: (event_time(event), event_identity(event)))


def word_events(
    canonical: tuple[str, ...], variants: tuple[tuple[str, ...], ...], observed: list[Segment],
    word_index: int, next_word: int | None, start: int, end: int, *,
    top_substitutions: int, top_additions: int, beam: float, addition_budget: int,
) -> list[dict]:
    """Keep arcs near the globally best path, including alternatives to its identities."""
    if not canonical or not observed or len(canonical) > 32 or len(observed) > 36:
        return []
    n, m = len(canonical), len(observed)
    graph = {(i, j): tuple(arcs_from(canonical, observed, i, j, top_substitutions, top_additions))
             for i in range(n + 1) for j in range(m + 1)}
    front = defaultdict(lambda: inf, {(0, 0, 0): 0.0})
    back = defaultdict(lambda: inf, {(n, m, used): 0.0 for used in range(addition_budget + 1)})
    for (i, j), arcs in graph.items():
        for used in range(addition_budget + 1):
            for arc in arcs:
                following = used + (arc.kind == "addition")
                if following <= addition_budget:
                    key = (arc.next_phone, arc.next_segment, following)
                    front[key] = min(front[key], front[i, j, used] + arc.cost)
    for (i, j), arcs in reversed(graph.items()):
        for used in range(addition_budget + 1):
            for arc in arcs:
                following = used + (arc.kind == "addition")
                if following <= addition_budget:
                    key = (arc.next_phone, arc.next_segment, following)
                    back[i, j, used] = min(back[i, j, used], arc.cost + back[key])

    best = back[0, 0, 0]
    if not isfinite(best):
        return []
    legal = allowed_edits(canonical, variants)
    result = []
    for (i, j), arcs in graph.items():
        for arc in arcs:
            if arc.kind is None or (i, arc.kind, arc.target, arc.actual) in legal:
                continue
            added = int(arc.kind == "addition")
            if added > addition_budget:
                continue
            cost = min(front[i, j, used] + arc.cost + back[arc.next_phone, arc.next_segment, used + added]
                       for used in range(addition_budget + 1 - added))
            if not isfinite(cost) or cost - best > beam:
                continue
            excess = max(0.0, cost - best)
            row = {"wordIndex": word_index, "phoneIndex": i, "kind": arc.kind, "target": arc.target,
                   "actual": arc.actual, "score": round(arc.support - excess, 6)}
            if arc.kind == "deletion":
                left = observed[j - 1].end if j else start
                right = observed[j].start if j < m else end
                row["anchorMs"] = (left + right) // 2
            else:
                row.update(startMs=observed[j].start, endMs=observed[j].end)
                if arc.kind == "addition" and i == n and next_word is not None:
                    row.update(wordIndex=next_word, phoneIndex=0)
            result.append(row)
    return compact_events(result)


def capped_by_window(rows: list[dict], maximum: int, reserve: bool = True) -> tuple[list[dict], dict]:
    groups = defaultdict(list)
    for event in rows:
        groups[int(event_time(event) // 16000)].append(event)
    result = []
    dropped = dict.fromkeys(KINDS, 0)
    for group in groups.values():
        ranked = sorted(group, key=lambda event: (-event["score"], event_time(event), event_identity(event)))
        keep = set()
        if reserve:
            for kind in KINDS:
                indexes = [index for index, event in enumerate(ranked) if event["kind"] == kind]
                keep.update(indexes[:maximum // len(KINDS)])
        for index in range(len(ranked)):
            if len(keep) >= maximum:
                break
            keep.add(index)
        for index, event in enumerate(ranked):
            if index in keep:
                result.append(event)
            else:
                dropped[event["kind"]] += 1
    return compact_events(result), dropped


def verified_events(first: list[dict], second: list[dict], tolerance_ms: int = 100) -> list[dict]:
    lookup = group_by_identity(second)
    result = []
    for identity, group in group_by_identity(first).items():
        other = lookup.get(identity, [])
        for i, j in closest_pairs(group, other, tolerance_ms):
            row, partner = group[i], other[j]
            result.append({**row, "score": min(row["score"], partner["score"])})
    return compact_events(result)
