#!/usr/bin/env python3
"""Map frozen ASR predictions to adjudicated word indexes for blind scoring."""

import argparse
import json
from pathlib import Path
import re
import unicodedata


def normalized_word(text):
    word = unicodedata.normalize("NFC", text).lower().replace("’", "'")
    if not re.fullmatch(r"[a-z]+(?:['-][a-z]+)*", word):
        raise ValueError(f"invalid normalized English token: {word!r}")
    return word


def costs(left, right):
    table = [list(range(len(right) + 1))]
    for i, token in enumerate(left, 1):
        row = [i]
        for j, other in enumerate(right, 1):
            row.append(min(table[-1][j] + 1, row[-1] + 1, table[-1][j - 1] + (token != other)))
        table.append(row)
    return table


def unique_matches(asr, reference):
    """Use only exact edges consumed by every minimum-edit alignment."""
    front = costs(asr, reference)
    back = costs(asr[::-1], reference[::-1])
    n, m = len(asr), len(reference)
    optimum = front[n][m]
    matches = []
    for i, token in enumerate(asr):
        options = set()
        for j in range(m + 1):
            start = front[i][j]
            if start + 1 + back[n - i - 1][m - j] == optimum:
                options.add(None)
            if j < m:
                exact = token == reference[j]
                if start + (not exact) + back[n - i - 1][m - j - 1] == optimum:
                    options.add(j if exact else None)
        matches.append(next(iter(options)) if len(options) == 1 else None)
    return matches


def clips(document):
    rows = document["clips"]
    result = {row["clipId"]: row for row in rows}
    if not result or len(result) != len(rows):
        raise ValueError("clip IDs must be unique and nonempty")
    return result


def phones(word):
    sequence = word["phones"]
    if not isinstance(sequence, list) or not sequence or not all(
        isinstance(phone, str) and re.fullmatch(r"[A-Z]+[012]?", phone) for phone in sequence
    ):
        raise ValueError("words need a canonical ARPAbet phone sequence")
    return sequence


def check_phone(event, sequence):
    index, kind, target = event["phoneIndex"], event["kind"], event["target"]
    if type(index) is not int or index < 0:
        return False
    if kind == "addition":
        return index <= len(sequence) and target == "∅"
    return kind in ("deletion", "substitution") and index < len(sequence) and sequence[index] == target


def align(reference_words, predictions):
    if reference_words["rulesSha256"] != predictions["rulesSha256"]:
        raise ValueError("use the same frozen normalization and canonical phone rules")
    reference, guesses = clips(reference_words), clips(predictions)
    if reference.keys() != guesses.keys():
        raise ValueError("every sealed clip needs exactly one prediction")
    result, audit = [], []
    for clip_id, clip in guesses.items():
        words = reference[clip_id]["words"]
        proposed = clip["words"]
        if clip["audioSha256"] != reference[clip_id]["audioSha256"]:
            raise ValueError("ASR and reference must use the same audio digest")
        mapping = unique_matches([normalized_word(row["word"]) for row in proposed],
                                 [normalized_word(row["word"]) for row in words])
        canonical, predicted = [phones(row) for row in words], [phones(row) for row in proposed]
        errors, resolutions = [], []
        for event in clip["errors"]:
            index = event["wordIndex"]
            if type(index) is not int or not 0 <= index < len(mapping):
                matched, reason = None, "invalid-asr-index"
            else:
                matched = mapping[index]
                if matched is None:
                    reason = "unmapped-asr-word"
                elif canonical[matched] != predicted[index] or not check_phone(event, canonical[matched]):
                    matched, reason = None, "incompatible-canonical-phone-index"
                else:
                    reason = "matched"
            # Null is an unresolved identity to the scorer and stays in the FP denominator.
            errors.append({**event, "wordIndex": matched})
            resolutions.append({"originalWordIndex": index, "wordIndex": matched, "reason": reason})
        result.append({**clip, "errors": errors})
        audit.append({"clipId": clip_id, "asrToReference": mapping, "events": resolutions})
    return {**predictions, "clips": result}, {"clips": audit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("reference_words", "predictions", "aligned", "audit"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    source = [json.loads(path.read_bytes()) for path in (args.reference_words, args.predictions)]
    aligned, audit = align(*source)
    for path, document in ((args.aligned, aligned), (args.audit, audit)):
        path.write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
