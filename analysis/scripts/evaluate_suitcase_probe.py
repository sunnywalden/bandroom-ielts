#!/usr/bin/env python3
"""Score frozen predictions on the publisher's development annotations."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

from align_predictions import check_phone, unique_matches
from event_matching import event_identity, match_events
from phone_graph import EMPTY, KINDS
from run_development_probe import pronunciations, tokens
from train_suitcase_probe import CALIBRATION, EVALUATION, PUBLISHER_SHA256, annotation, sha256, tiers


CATEGORIES = dict(zip(("s", "d", "a"), KINDS))


def owner(phone, words):
    overlaps = [(max(0, min(phone.end, word.end) - max(phone.start, word.start)), index)
                for index, word in enumerate(words) if word.start < phone.end and word.end > phone.start]
    overlaps.sort(reverse=True)
    if not overlaps or (len(overlaps) > 1 and overlaps[0][0] - overlaps[1][0] < 1e-6):
        return None
    return overlaps[0][1]


def reference(text: str) -> tuple[list[dict], list[dict], float]:
    labels = tiers(text)
    intervals = [word for word in labels["words"] if len(tokens(word.label)) == 1]
    words = []
    for row in intervals:
        word = tokens(row.label)[0]
        variants = pronunciations(word)
        words.append({"word": word, "phones": list(variants[0]) if variants else []})
    effective_seconds = sum(word.end - word.start for word in intervals)

    phones = []
    sequences = defaultdict(list)
    for row in labels["phones"]:
        target, actual, kind = annotation(row.label)
        index = owner(row, intervals)
        phones.append((row, target, actual, kind, index))
        if index is not None and target != "SIL" and kind != "a" and row.label:
            sequences[index].append((row, target or "?"))
    mappings = {}
    for index, items in sequences.items():
        found = unique_matches([phone for _, phone in items], words[index]["phones"])
        mappings[index] = {row: position for (row, _), position in zip(items, found)}

    events = []
    for row, target, actual, kind, index in phones:
        if kind not in CATEGORIES:
            continue
        position, reason = None, None
        if kind == "a":
            if index is None:
                index = next((i for i, word in enumerate(intervals) if 0 <= word.start - row.end <= 0.3), None)
            if index is not None and words[index]["phones"]:
                entries = mappings.get(index, {})
                before = [(phone, pos) for phone, pos in entries.items() if phone.end <= row.start + 0.000001]
                after = [(phone, pos) for phone, pos in entries.items() if phone.start >= row.end - 0.000001]
                left = max(before, key=lambda item: item[0].end)[1] if before else -1
                right = min(after, key=lambda item: item[0].start)[1] if after else len(words[index]["phones"])
                if left is not None and right == left + 1:
                    position = right
                    if position == len(words[index]["phones"]) and index + 1 < len(words):
                        index, position = index + 1, 0
        elif index is not None:
            position = mappings.get(index, {}).get(row)
        if index is None:
            reason = "publisher_word_unresolved"
        elif not words[index]["phones"]:
            reason = "canonical_oov"
        elif position is None:
            reason = "publisher_phone_index_unresolved"
        elif (kind in ("s", "d") and target in (None, "SIL")) or (kind in ("s", "a") and actual in (None, "SIL")):
            reason = "publisher_phone_outside_inventory"
        elif kind == "s" and target == actual:
            reason = "publisher_phones_collapse_under_normalization"
        event = {"wordIndex": index, "phoneIndex": position if reason is None else None,
                 "kind": CATEGORIES[kind], "target": EMPTY if kind == "a" else target,
                 "actual": EMPTY if kind == "d" else actual, "referenceIssue": reason}
        if kind == "d":
            # The publisher annotated an interval. Its midpoint is a development
            # proxy for the adjudicated gap anchor required by the release protocol.
            event["anchorMs"] = round((row.start + row.end) * 500, 3)
        else:
            event.update(startMs=round(row.start * 1000, 3), endMs=round(row.end * 1000, 3))
        events.append(event)
    return words, events, effective_seconds


def aligned(document, words, events, seconds):
    proposed = document["words"]
    mapping = unique_matches([row["word"] for row in proposed], [row["word"] for row in words])
    stages = {}
    for name in ("beforeCap", "beforeVerification", "candidates"):
        rows = []
        for event in document[name]:
            predicted = event["wordIndex"]
            index = mapping[predicted]
            valid = (index is not None and proposed[predicted]["phones"] == words[index]["phones"]
                     and check_phone(event, words[index]["phones"]))
            rows.append({**event, "wordIndex": index if valid else None})
        stages[name] = rows
    return {"clipId": document["clipId"], "events": events, "mappedWords": set(mapping) - {None},
            "words": words, "seconds": seconds, **stages}


def threshold_selection(calibration):
    settings = {}
    for kind in KINDS:
        truths, candidates = Counter(), defaultdict(list)
        for clip in calibration:
            for event in clip["events"]:
                if event["kind"] == kind:
                    truths[clip["clipId"], event_identity(event)] += 1
            for event in clip["candidates"]:
                if event["kind"] == kind:
                    candidates[event["score"]].append((clip["clipId"], event_identity(event)))
        seen = Counter()
        detections = matches = 0
        qualified = diagnostic = None
        for score, keys in sorted(candidates.items(), reverse=True):
            detections += len(keys)
            for key in keys:
                seen[key] += 1
                matches += seen[key] <= truths[key]
            if detections < 5 or not truths:
                continue
            point = {"threshold": score, "predictions": detections, "tp": matches,
                     "precision": matches / detections, "recall": matches / truths.total(),
                     "f1": 2 * matches / (detections + truths.total())}
            if point["precision"] >= 0.85 and (qualified is None or matches > qualified["tp"]):
                qualified = point
            if diagnostic is None or point["f1"] > diagnostic["f1"]:
                diagnostic = point
        settings[kind] = {"atPrecision85": qualified, "bestF1Diagnostic": diagnostic}
    return settings


def report(clip, settings):
    truth = clip["events"]
    stages = {stage: clip[stage] for stage in ("beforeCap", "beforeVerification", "candidates")}
    for mode in ("atPrecision85", "bestF1Diagnostic"):
        stages[mode] = [event for event in clip["candidates"]
                        if (threshold := settings[event["kind"]][mode]) is not None
                        and event["score"] >= threshold["threshold"]]
    results = {}
    for kind in ("all", *KINDS):
        expected = [event for event in truth if kind in ("all", event["kind"])]
        counts = {"reference": len(expected), "mappedWord": sum(event["wordIndex"] in clip["mappedWords"] for event in expected),
                  "mappedIdentity": sum(event["wordIndex"] in clip["mappedWords"] and event["referenceIssue"] is None
                                        for event in expected),
                  "referenceIssues": dict(Counter(event["referenceIssue"] for event in expected if event["referenceIssue"]))}
        for stage, rows in stages.items():
            proposed = [event for event in rows if kind in ("all", event["kind"])]
            pairs = match_events(expected, proposed)
            counts[stage] = {"predictions": len(proposed), "tp": len(pairs), "timedTp": sum(timed for _, _, timed in pairs),
                             "fp": len(proposed) - len(pairs), "fn": len(expected) - len(pairs)}
        results[kind] = counts
    return results


def aggregate(reports):
    def divide(n, d):
        return n / d if d else None

    result = {}
    for kind, first in reports[0].items():
        rows = [row[kind] for row in reports]
        totals = {key: sum(row[key] for row in rows) for key in ("reference", "mappedWord", "mappedIdentity")}
        totals["referenceIssues"] = dict(sum((Counter(row["referenceIssues"]) for row in rows), Counter()))
        for name in ("beforeCap", "beforeVerification", "candidates", "atPrecision85", "bestF1Diagnostic"):
            counts = {key: sum(row[name][key] for row in rows) for key in first[name]}
            counts.update(precision=divide(counts["tp"], counts["predictions"]),
                          recall=divide(counts["tp"], totals["reference"]),
                          timedRecall=divide(counts["timedTp"], totals["reference"]),
                          jointPrecision=divide(counts["timedTp"], counts["predictions"]),
                          timingAmongTp=divide(counts["timedTp"], counts["tp"]))
            totals[name] = counts
        result[kind] = totals
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("archive", "predictions", "training_manifest", "output"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    if sha256(args.archive) != PUBLISHER_SHA256:
        parser.error("publisher archive does not match the pinned version")
    training = json.loads(args.training_manifest.read_bytes())
    training_hash = sha256(args.training_manifest)
    if (training["publisherArchiveSha256"] != PUBLISHER_SHA256 or training["developmentOnly"] is not True
            or ({row["clipId"] for row in training["sources"]} & (CALIBRATION | EVALUATION))):
        parser.error("training manifest does not establish the development split")

    evidence = {}
    fingerprint = None
    with ZipFile(args.archive) as archive:
        def load_clip(clip_id):
            nonlocal fingerprint
            path = args.predictions / f"{clip_id}.json"
            document = json.loads(path.read_bytes())
            audio = archive.read(f"suitcase_corpus/wav/{clip_id}.wav")
            if (document["clipId"] != clip_id or document["audioSha256"] != hashlib.sha256(audio).hexdigest()
                    or document["trainingManifestSha256"] != training_hash
                    or document["probeSha256"] != training["probeSha256"] or document["developmentOnly"] is not True):
                parser.error(f"{clip_id} is not bound to the supplied audio and training manifest")
            version = {key: document[key] for key in ("encoderSha256", "whisperSha256", "whisperBinarySha256",
                                                       "probeSha256", "settings", "environment")}
            if fingerprint is not None and fingerprint != version:
                parser.error("calibration and evaluation must use the same frozen configuration")
            fingerprint = version
            text = archive.read(f"suitcase_corpus/annotation/{clip_id}.TextGrid").decode("utf-8-sig")
            evidence[clip_id] = {"predictionSha256": sha256(path), "runtime": document["runtime"],
                                 "acousticPasses": document["acousticPasses"]}
            return aligned(document, *reference(text))

        calibration = [load_clip(clip_id) for clip_id in sorted(CALIBRATION)]
        settings = threshold_selection(calibration)
        evaluation = [load_clip(clip_id) for clip_id in sorted(EVALUATION)]

    summary = {"developmentOnly": True, "publisherArchiveSha256": PUBLISHER_SHA256,
               "trainingManifestSha256": training_hash, "version": fingerprint,
               "calibration": settings, "calibrationMinPredictionsPerClass": 5,
               "timingToleranceMs": 150, "deletionAnchorSource": "publisher_interval_midpoint"}
    for label, clips in (("calibration", calibration), ("evaluation", evaluation)):
        reports = []
        for clip in clips:
            metrics = report(clip, settings)
            reports.append(metrics)
            evidence[clip["clipId"]].update(referenceWordSeconds=clip["seconds"], metrics=metrics)
        summary[f"{label}Totals"] = aggregate(reports)
    summary["clips"] = evidence
    with args.output.open("x") as output:
        json.dump(summary, output, ensure_ascii=False, indent=2, allow_nan=False)
        output.write("\n")
    for kind, row in summary["evaluationTotals"].items():
        print(f"{kind}: W {row['mappedWord']}/{row['reference']}; "
              f"C_id {row['candidates']['tp']}/{row['reference']}; "
              f"C_time {row['candidates']['timedTp']}/{row['reference']}; "
              f"at P85 {row['atPrecision85']['tp']}/{row['atPrecision85']['predictions']} predictions; "
              f"diagnostic {row['bestF1Diagnostic']['tp']}/{row['bestF1Diagnostic']['predictions']} predictions")


if __name__ == "__main__":
    main()
