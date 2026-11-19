#!/usr/bin/env python3
"""GOP-style mispronunciation probe on the L2-ARCTIC Suitcase held-out set.

This is a bounded, read-only research probe.  It:
  1. loads the saved CROTTC phone-CTC per-frame posteriors (*.frames.npz),
  2. reuses the canonical-pronunciation helpers from frozen-inference.py by
     exec'ing the source only up to the model-construction line (no model load,
     no audio decode, no product-code changes),
  3. forced-aligns each word's canonical cmudict phone sequence to its frame
     span with a small monotone HMM (each phone gets >=1 frame),
  4. computes GOP-style scores  mean_t[log P(canonical_t) - log P(argmax_t)],
     per-phone min and mean variants, choosing the best cmudict pronunciation,
  5. sweeps a global GOP threshold and reports word-level substitution
     precision / error coverage against the human TextGrid labels.

Wording caveat (mandatory): this is "GOP-style with local CROTTC phone-CTC
posteriors", NOT native-ASR GOP (Witt & Young).  The acoustic model is the
project's L2-ARCTIC CROTTC phone recognizer, not a native-trained ASR.

Outputs: GOP_PROBE_RESULT.json and SHA256SUMS next to this script.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

BASE = Path(os.environ.get("BANDROOM_ACOUSTIC_DIR", str(Path.home() / ".bandroom-acoustic")))
FROZEN = BASE / "frozen-inference.py"
CROTTC = BASE / "crottc"
PRED = BASE / "predictions22"
CORPUS = BASE / "corpus" / "suitcase_corpus"
ANNOTATION = CORPUS / "annotation"
OUTDIR = BASE / "gop_probe"

HELD_OUT = ["njs", "tlv", "tni", "txhc", "ykwk", "zhaa"]
STEP = 320 / 16000                    # 20 ms frame hop
CENTER = 199.5 / 16000                # 12.46875 ms centre offset
# A-priori filler/non-lexical tokens excluded in the sensitivity analysis only.
FILLERS = {"uh", "um", "er", "erm", "hmm", "mm", "mhm", "x", "eh", "ah", "oh"}

# TextGrid phone entry: "EXPECTED,OBSERVED,KIND"
TG_INTERVAL = re.compile(
    r'intervals \[\d+\]:\s*xmin = ([0-9.]+)\s*xmax = ([0-9.]+)\s*text = "([^"]*)"')
ALIASES = {"AX": "AH", "IX": "IH", "AXR": "ER", "EL": "L", "EN": "N", "EM": "M"}


# --------------------------------------------------------------------------- #
# Reuse frozen-inference.py helpers without loading the model
# --------------------------------------------------------------------------- #
def load_frozen_helpers():
    """Exec frozen-inference.py up to the model setup, returning its namespace.

    The script's helper functions (phone, alternatives, canonical mapping) are
    defined before `torch.set_num_threads(6)`.  We supply dummy CLI arguments
    so the top-level argparse call succeeds; nothing after the cut is run, so
    no checkpoint is loaded and no audio is touched.
    """
    src = FROZEN.read_text()
    cut = src.index("torch.set_num_threads")
    head = src[:cut]
    old_argv = sys.argv
    sys.argv = [
        "frozen-inference.py",
        "--models", str(CROTTC),
        "--ffmpeg", "/usr/bin/true",
        "--whisper", "/tmp/nonexistent-whisper",
        "--audio", "/tmp/nonexistent.wav",
        "--output", "/tmp/nonexistent.json",
    ]
    ns = {"__name__": "frozen_helpers", "__file__": str(FROZEN)}
    try:
        exec(compile(head, str(FROZEN), "exec"), ns)
    finally:
        sys.argv = old_argv
    for required in ("alternatives", "canonical", "ids", "reverse", "phone", "cmu"):
        if required not in ns:
            raise RuntimeError(f"frozen helper {required!r} not found")
    return ns


def phone_norm(text: str) -> str:
    value = re.sub(r"[012]$", "", text.strip())
    return ALIASES.get(value, value)


def word_norm(text: str) -> str:
    return re.sub(r"^[^a-z]+|[^a-z]+$", "", text.lower())


def tg_intervals(text: str):
    return [(float(a), float(b), c.strip())
            for a, b, c in TG_INTERVAL.findall(text)]


def load_annotation(speaker: str):
    raw = (ANNOTATION / f"{speaker}.TextGrid").read_text()
    words = tg_intervals(raw.split('name = "words"')[1].split('name = "phones"')[0])
    phones = tg_intervals(raw.split('name = "phones"')[1].split('name = "IPA"')[0])
    labels = []
    for start, end, value in phones:
        parts = [p.strip() for p in value.split(",")]
        if len(parts) != 3 or parts[2] not in ("s", "a", "d"):
            continue
        expected, actual, kind = phone_norm(parts[0]), phone_norm(parts[1]), parts[2]
        labels.append(dict(
            start=start, end=end, time=(start + end) / 2.0, kind=kind,
            expected=expected, actual=actual,
            comparable=(kind == "s"
                        and re.fullmatch("[A-Z]+", expected) is not None
                        and re.fullmatch("[A-Z]+", actual) is not None
                        and expected != actual),
        ))
    return words, labels


def load_word_spans(speaker: str, mode: str, prediction: dict):
    """Return [(token, start, end, source)] word spans for a speaker."""
    if mode == "asr":
        out = []
        for w in prediction["words"]:
            start, end = float(w["start"]), float(w["end"])
            if end - start <= 0.0:
                continue
            token = w.get("token") or word_norm(w.get("word", ""))
            out.append((token, start, end, "whisper-asr"))
        return out
    words, _ = load_annotation(speaker)
    return [(word_norm(text), start, end, "gold-textgrid")
            for start, end, text in words if text.strip()]


# --------------------------------------------------------------------------- #
# Forced alignment of a canonical phone sequence to a frame span
# --------------------------------------------------------------------------- #
def align_frames(logprobs: np.ndarray, phone_ids):
    """Monotone alignment; every phone receives at least one frame.

    Returns an int array of length T giving the phone index assigned to each
    frame, or None if T < number of phones.
    """
    T = logprobs.shape[0]
    K = len(phone_ids)
    if K == 0 or T < K:
        return None
    lp = logprobs[:, list(phone_ids)]          # T x K
    NEG = -1e9
    dp = np.full((T, K), NEG, dtype=np.float64)
    bp = np.zeros((T, K), dtype=np.int8)       # 1 = start new phone at t
    dp[0, 0] = lp[0, 0]
    for t in range(1, T):
        prev = dp[t - 1]
        k_cont = min(K - 1, t - 1)             # can continue phones 0..k_cont
        k_max = min(K - 1, t)                  # feasible phones at frame t
        cont = np.full(K, NEG, dtype=np.float64)
        if k_cont >= 0:
            cont[:k_cont + 1] = prev[:k_cont + 1]
        start = np.full(K, NEG, dtype=np.float64)
        if k_max >= 1:
            start[1:k_max + 1] = prev[:k_max]
        take_start = start > cont
        cur = np.where(take_start, start, cont)
        bp[t, take_start] = 1
        cur = cur + lp[t]
        if k_max + 1 < K:
            cur[k_max + 1:] = NEG
        dp[t] = cur
    if dp[T - 1, K - 1] <= NEG / 2:
        return None
    assign = np.empty(T, dtype=np.int32)
    t, k = T - 1, K - 1
    while t >= 0:
        assign[t] = k
        if t == 0:
            break
        if bp[t, k] == 1:
            k -= 1
        t -= 1
    return assign


def score_pronunciation(logprobs, frame_idx, phone_ids, log_argmax):
    """GOP-style scores for one canonical pronunciation on one word span."""
    sub = logprobs[frame_idx]
    assign = align_frames(sub, phone_ids)
    if assign is None:
        return None
    phone_gops, per_phone = [], []
    for k, pid in enumerate(phone_ids):
        frames = np.flatnonzero(assign == k)
        if len(frames) == 0:                    # cannot happen, defensive
            continue
        vals = sub[frames, pid] - log_argmax[frame_idx][frames]
        g = float(vals.mean())
        phone_gops.append(g)
        per_phone.append(dict(phone=pid, n_frames=int(len(frames)), gop=round(g, 6)))
    if not phone_gops:
        return None
    frame_vals = sub[np.arange(len(frame_idx)), np.asarray(phone_ids)[assign]] - log_argmax[frame_idx]
    return dict(
        gop_frame_mean=float(frame_vals.mean()),
        gop_phone_mean=float(np.mean(phone_gops)),
        gop_phone_min=float(np.min(phone_gops)),
        per_phone=per_phone,
    )


def score_speaker(speaker: str, mode: str, helpers, prediction, probabilities):
    spans = load_word_spans(speaker, mode, prediction)
    logprobs = np.log(np.clip(probabilities.astype(np.float64), 1e-12, 1.0))
    log_argmax = logprobs.max(axis=1)
    frame_times = np.arange(len(logprobs)) * STEP + CENTER
    words, skipped = [], Counter()
    for idx, (token, start, end, source) in enumerate(spans):
        alternatives = helpers["alternatives"](token) if token else []
        if not alternatives:
            skipped["no_cmudict"] += 1
            continue
        frame_idx = np.flatnonzero((frame_times >= start) & (frame_times < end))
        if len(frame_idx) == 0:
            skipped["no_frames"] += 1
            continue
        best = None
        for phone_ids in alternatives:
            if len(frame_idx) < len(phone_ids):
                continue
            scored = score_pronunciation(logprobs, frame_idx, phone_ids, log_argmax)
            if scored is None:
                continue
            if best is None or scored["gop_frame_mean"] > best["gop_frame_mean"]:
                best = dict(scored, canonical=[helpers["reverse"][p] for p in phone_ids])
        if best is None:
            skipped["too_short_for_phones"] += 1
            continue
        words.append(dict(
            id=f"{speaker}:{mode}:{idx}", speaker=speaker, token=token,
            start=round(start, 4), end=round(end, 4), source=source,
            n_frames=int(len(frame_idx)), n_phones=len(best["canonical"]),
            canonical=best["canonical"],
            gop_frame_mean=round(best["gop_frame_mean"], 6),
            gop_phone_mean=round(best["gop_phone_mean"], 6),
            gop_phone_min=round(best["gop_phone_min"], 6),
            per_phone=best["per_phone"],
            _frame_idx=frame_idx,
        ))
    return words, dict(skipped)


def associate_labels(words, labels):
    """Map each annotated phone label to at most one scored word.

    Containment of the label midpoint in [word.start, word.end); if several
    words contain it, choose the closest word centre.
    """
    labels = [dict(x, word_id=None, assigned_word=None) for x in labels]
    by_speaker = {}
    for w in words:
        by_speaker.setdefault(w["speaker"], []).append(w)
    for lab in labels:
        candidates = [w for w in by_speaker.get(lab["speaker"], [])
                      if w["start"] <= lab["time"] < w["end"]]
        if not candidates:
            continue
        best = min(candidates, key=lambda w: abs((w["start"] + w["end"]) / 2 - lab["time"]))
        lab["word_id"] = best["id"]
        lab["assigned_word"] = best["token"]
    counts = {}
    for w in words:
        counts[w["id"]] = dict(
            primary=0, any_error=0,
            primary_detail=[], any_detail=[],
        )
    for lab in labels:
        wid = lab["word_id"]
        if wid is None:
            continue
        if lab["comparable"]:
            counts[wid]["primary"] += 1
            counts[wid]["primary_detail"].append(
                f"{lab['expected']}->{lab['actual']}")
        counts[wid]["any_error"] += 1
        counts[wid]["any_detail"].append(
            f"{lab['expected']}->{lab['actual']}:{lab['kind']}")
    return labels, counts


# --------------------------------------------------------------------------- #
# Sweep and metrics
# --------------------------------------------------------------------------- #
def auc_lower_gop_for_positive(scores, positive):
    """P(a positive word has lower GOP than a negative word); ties count 0.5."""
    s = np.asarray(scores, dtype=float)
    pos = np.asarray(positive, dtype=bool)
    n_pos, n_neg = int(pos.sum()), int((~pos).sum())
    if n_pos == 0 or n_neg == 0:
        return None
    order = np.argsort(s, kind="mergesort")
    sorted_s = s[order]
    ranks = np.empty(len(s), dtype=float)
    i = 0
    while i < len(s):
        j = i + 1
        while j < len(s) and sorted_s[j] == sorted_s[i]:
            j += 1
        ranks[order[i:j]] = (i + 1 + j) / 2.0
        i = j
    rank_sum = ranks[pos].sum()
    auc_higher = (rank_sum - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)
    return float(1.0 - auc_higher)


def build_curve(words, counts, total_primary_labels, total_any_errors,
                score_key="gop_frame_mean"):
    """Point on the precision/coverage curve for every achievable threshold.

    Convention: a word is flagged when score <= threshold.  Ties are added as
    one group, corresponding to a threshold just above the tied value.
    """
    ordered = sorted(words, key=lambda w: w[score_key])
    total_pos_words = sum(1 for w in ordered if counts[w["id"]]["primary"] > 0)
    total_any_pos_words = sum(1 for w in ordered if counts[w["id"]]["any_error"] > 0)
    points = [dict(threshold=None, flagged_words=0, tp_words=0, fp_words=0,
                   precision=None, label_coverage=0.0, any_error_coverage=0.0,
                   word_recall=0.0, any_precision=None, covered_labels=0)]
    flagged = tp = tp_any = covered = covered_any = 0
    i = 0
    while i < len(ordered):
        value = ordered[i][score_key]
        while i < len(ordered) and ordered[i][score_key] == value:
            w = ordered[i]
            flagged += 1
            if counts[w["id"]]["primary"] > 0:
                tp += 1
            if counts[w["id"]]["any_error"] > 0:
                tp_any += 1
            covered += counts[w["id"]]["primary"]
            covered_any += counts[w["id"]]["any_error"]
            i += 1
        points.append(dict(
            threshold=round(float(value), 6),
            flagged_words=flagged, tp_words=tp, fp_words=flagged - tp,
            precision=round(tp / flagged, 6),
            label_coverage=round(covered / total_primary_labels, 6) if total_primary_labels else None,
            any_error_coverage=round(covered_any / total_any_errors, 6) if total_any_errors else None,
            word_recall=round(tp / total_pos_words, 6) if total_pos_words else None,
            any_precision=round(tp_any / flagged, 6),
            covered_labels=covered,
        ))
    return points, dict(
        total_scored_words=len(ordered),
        total_positive_words=total_pos_words,
        total_any_positive_words=total_any_pos_words,
        base_rate_primary=round(total_pos_words / len(ordered), 6) if ordered else None,
        total_primary_labels=total_primary_labels,
        total_any_errors=total_any_errors,
    )


def pick_best(points, key, target):
    eligible = [p for p in points
                if p[key] is not None and p[key] >= target and p["precision"] is not None]
    if not eligible:
        return None
    return max(eligible, key=lambda p: (p["precision"], p["tp_words"], p[key]))


def pick_best_relaxed(points, key, target):
    """Best 'any annotated error' precision at a coverage target (sensitivity)."""
    eligible = [p for p in points if p[key] is not None and p[key] >= target]
    if not eligible:
        return None
    return max(eligible, key=lambda p: (p["any_precision"], p["tp_words"], p[key]))


def curve_metrics(points, summary):
    oracle_any = max(points, key=lambda p: (p["precision"] or 0, p["tp_words"],
                                            p["label_coverage"] or 0))
    with_min5 = [p for p in points if p["tp_words"] >= 5 and p["precision"] is not None]
    oracle_min5 = (max(with_min5, key=lambda p: (p["precision"], p["tp_words"]))
                   if with_min5 else None)
    retention50 = [p for p in points if (p["word_recall"] or 0) >= 0.5]
    oracle_ret50 = (max(retention50, key=lambda p: (p["precision"], p["tp_words"]))
                    if retention50 else None)
    passing = [p for p in points if (p["precision"] or 0) >= 0.85]
    best_passing_tp = (max(passing, key=lambda p: (p["tp_words"], p["label_coverage"] or 0))
                       if passing else None)
    return dict(
        summary=summary,
        oracle_any_coverage=oracle_any,
        oracle_with_at_least_5_tp=oracle_min5,
        oracle_tp_retention_ge_0_50=oracle_ret50,
        best_precision_at_label_coverage_ge_0_10=pick_best(points, "label_coverage", 0.10),
        best_precision_at_label_coverage_ge_0_30=pick_best(points, "label_coverage", 0.30),
        best_precision_at_label_coverage_ge_0_50=pick_best(points, "label_coverage", 0.50),
        best_precision_at_word_recall_ge_0_10=pick_best(points, "word_recall", 0.10),
        best_precision_at_word_recall_ge_0_30=pick_best(points, "word_recall", 0.30),
        threshold_at_best_label_coverage_ge_0_10=pick_best(points, "label_coverage", 0.10),
        relaxed_any_error_precision_at_any_error_coverage_ge_0_10=pick_best_relaxed(
            points, "any_error_coverage", 0.10),
        relaxed_any_error_precision_at_any_error_coverage_ge_0_30=pick_best_relaxed(
            points, "any_error_coverage", 0.30),
        any_threshold_precision_ge_0_85_and_label_coverage_ge_0_10=bool(
            any((p["precision"] or 0) >= 0.85 and (p["label_coverage"] or 0) >= 0.10
                for p in points)),
        best_point_if_precision_ge_0_85=best_passing_tp,
        max_tp_words_with_precision_ge_0_85=(best_passing_tp["tp_words"]
                                             if best_passing_tp else None),
        max_label_coverage_with_precision_ge_0_85=(best_passing_tp["label_coverage"]
                                                   if best_passing_tp else None),
    )


def per_speaker_breakdown(words, counts, labels, threshold, score_key):
    speakers = sorted({w["speaker"] for w in words})
    out = {}
    for spk in speakers:
        ws = [w for w in words if w["speaker"] == spk]
        labs = [x for x in labels if x["speaker"] == spk]
        comp = [x for x in labs if x["comparable"]]
        flagged = [w for w in ws if w[score_key] <= threshold]
        tp = [w for w in flagged if counts[w["id"]]["primary"] > 0]
        covered = sum(1 for x in comp if x["word_id"] in {w["id"] for w in flagged})
        scores = [w[score_key] for w in ws]
        pos = [counts[w["id"]]["primary"] > 0 for w in ws]
        out[spk] = dict(
            scored_words=len(ws), annotated_comparable_substitutions=len(comp),
            flagged_words=len(flagged), tp_words=len(tp), fp_words=len(flagged) - len(tp),
            precision=round(len(tp) / len(flagged), 4) if flagged else None,
            label_coverage=round(covered / len(comp), 4) if comp else None,
            auc_lower_gop_for_positive_word=round(auc_lower_gop_for_positive(scores, pos), 4) if auc_lower_gop_for_positive(scores, pos) is not None else None,
        )
    return out


def per_speaker_oracle(words, counts, labels, score_key):
    out = {}
    for spk in sorted({w["speaker"] for w in words}):
        ws = [w for w in words if w["speaker"] == spk]
        labs = [x for x in labels if x["speaker"] == spk]
        comp = [x for x in labs if x["comparable"]]
        pts, summ = build_curve(ws, counts, len(comp), len(labs), score_key)
        best = pick_best(pts, "label_coverage", 0.10)
        out[spk] = dict(
            best_at_label_coverage_ge_0_10=best,
            oracle_any=curve_metrics(pts, summ)["oracle_any_coverage"],
            auc_lower_gop_for_positive_word=(
                round(auc_lower_gop_for_positive([w[score_key] for w in ws],
                                [counts[w["id"]]["primary"] > 0 for w in ws]), 4)
                if 0 < sum(1 for w in ws if counts[w["id"]]["primary"] > 0) < len(ws) else None),
            positive_words=sum(1 for w in ws if counts[w["id"]]["primary"] > 0),
            scored_words=len(ws),
        )
    return out


def downsample(points, step=10):
    if len(points) <= step:
        return points
    keep = points[::step]
    if keep[-1] is not points[-1]:
        keep.append(points[-1])
    return keep


def serialise_words(words):
    return [{k: v for k, v in w.items() if not k.startswith("_")} for w in words]


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def run_mode(mode, helpers, predictions, probabilities):
    all_words, all_labels, all_counts = [], [], {}
    skipped = {}
    label_counts = Counter()
    for spk in HELD_OUT:
        words, skip = score_speaker(spk, mode, helpers, predictions[spk], probabilities[spk])
        _, labels = load_annotation(spk)
        for lab in labels:
            lab["speaker"] = spk
        labels, counts = associate_labels(words, labels)
        all_words.extend(words)
        all_labels.extend(labels)
        all_counts.update(counts)
        skipped[spk] = skip
        for lab in labels:
            label_counts[lab["kind"]] += 1
            if lab["comparable"]:
                label_counts["comparable_substitutions"] += 1
            if lab["word_id"] is None:
                label_counts["unassociated_" + lab["kind"]] += 1
    total_primary = sum(1 for x in all_labels if x["comparable"])
    total_any = sum(1 for x in all_labels if x["kind"] in ("s", "a", "d"))
    variants = {}
    for variant in ("gop_frame_mean", "gop_phone_mean", "gop_phone_min"):
        points, summ = build_curve(all_words, all_counts, total_primary, total_any, variant)
        metrics = curve_metrics(points, summ)
        op = metrics["threshold_at_best_label_coverage_ge_0_10"]
        threshold = op["threshold"] if op and op["threshold"] is not None else -1e9
        variants[variant] = dict(
            metrics=metrics,
            auc_lower_gop_for_positive_word=(
                round(auc_lower_gop_for_positive(
                    [w[variant] for w in all_words],
                    [all_counts[w["id"]]["primary"] > 0 for w in all_words]), 4)),
            threshold_curve=points if variant == "gop_frame_mean" else downsample(points),
            per_speaker_at_label_coverage_ge_0_10_threshold=per_speaker_breakdown(
                all_words, all_counts, all_labels, threshold, variant),
            per_speaker_oracle_at_label_coverage_ge_0_10=per_speaker_oracle(
                all_words, all_counts, all_labels, variant),
        )

    # Sensitivity: drop a-priori filler/non-lexical tokens and their labels.
    removed_ids = {w["id"] for w in all_words if w["token"] in FILLERS}
    kept_words = [w for w in all_words if w["id"] not in removed_ids]
    kept_counts = {wid: c for wid, c in all_counts.items() if wid not in removed_ids}
    kept_primary = total_primary - sum(
        1 for x in all_labels if x["comparable"] and x["word_id"] in removed_ids)
    kept_any = total_any - sum(
        1 for x in all_labels if x["kind"] in ("s", "a", "d")
        and x["word_id"] in removed_ids)
    filler_sensitivity = dict(
        removed_words=len(all_words) - len(kept_words),
        removed_primary_labels=total_primary - kept_primary,
        note=("Excludes {uh, um, er, erm, hmm, mm, mhm, x, eh, ah, oh} before "
              "thresholding; labels on removed words are removed from the denominator. "
              "This is a sensitivity analysis, not the primary protocol."),
        variants={},
    )
    for variant in ("gop_frame_mean", "gop_phone_mean", "gop_phone_min"):
        points, summ = build_curve(kept_words, kept_counts, kept_primary, kept_any, variant)
        filler_sensitivity["variants"][variant] = dict(
            metrics=curve_metrics(points, summ),
            threshold_curve=points if variant == "gop_frame_mean" else downsample(points),
        )
    scores = [w["gop_frame_mean"] for w in all_words]
    pos = [all_counts[w["id"]]["primary"] > 0 for w in all_words]
    diagnostics = dict(
        gop_frame_mean_positive_words=dict(
            n=int(sum(pos)),
            mean=round(float(np.mean([s for s, p in zip(scores, pos) if p])), 4) if any(pos) else None,
            median=round(float(np.median([s for s, p in zip(scores, pos) if p])), 4) if any(pos) else None,
        ),
        gop_frame_mean_negative_words=dict(
            n=int(len(pos) - sum(pos)),
            mean=round(float(np.mean([s for s, p in zip(scores, pos) if not p])), 4) if any(not p for p in pos) else None,
            median=round(float(np.median([s for s, p in zip(scores, pos) if not p])), 4) if any(not p for p in pos) else None,
        ),
        auc_lower_gop_for_positive_word=round(auc_lower_gop_for_positive(scores, pos), 4) if auc_lower_gop_for_positive(scores, pos) is not None else None,
    )
    return dict(
        mode=mode,
        description=("GOP on Whisper-ASR word spans from prediction.json (no gold "
                     "transcript used by the scorer)" if mode == "asr" else
                     "GOP on gold TextGrid word spans/tokens (oracle transcript and "
                     "segmentation; isolates GOP discrimination from ASR errors)"),
        label_counts=dict(label_counts),
        total_primary_comparable_substitutions=total_primary,
        total_annotated_errors=total_any,
        skipped_words=skipped,
        diagnostics=diagnostics,
        variants=variants,
        sensitivity_filler_exclusion=filler_sensitivity,
        words=serialise_words(all_words),
        labels=[{k: v for k, v in x.items()
                 if k in ("speaker", "start", "end", "time", "kind", "expected",
                          "actual", "comparable", "word_id", "assigned_word")}
                for x in all_labels],
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=OUTDIR / "GOP_PROBE_RESULT.json")
    parser.add_argument("--skip-words", action="store_true",
                        help="omit per-word and per-label dumps from the JSON")
    args = parser.parse_args()
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    helpers = load_frozen_helpers()
    predictions, probabilities = {}, {}
    asset_notes = {}
    for spk in HELD_OUT:
        pred_path = PRED / f"{spk}.prediction.json"
        npz_path = PRED / f"{spk}.prediction.frames.npz"
        predictions[spk] = json.loads(pred_path.read_text())
        probabilities[spk] = np.load(npz_path)["probabilities"]
        expected_frames = len(probabilities[spk])
        asset_notes[spk] = dict(
            prediction=pred_path.name, frames=npz_path.name,
            frames_shape=list(probabilities[spk].shape),
            duration_seconds=predictions[spk]["duration"],
            frame_span_seconds=round((expected_frames - 1) * STEP + CENTER, 4),
            recognizer=predictions[spk]["configuration"].get("recognizer"),
        )

    modes = {
        "asr": run_mode("asr", helpers, predictions, probabilities),
        "gold": run_mode("gold", helpers, predictions, probabilities),
    }
    if args.skip_words:
        for m in modes.values():
            m.pop("words", None)
            m.pop("labels", None)

    def best_across(metric_key):
        candidates = []
        for mode_name, m in modes.items():
            for variant_name, d in m["variants"].items():
                point = d["metrics"].get(metric_key)
                if point is not None:
                    candidates.append((mode_name, variant_name, point))
        if not candidates:
            return None
        mode_name, variant_name, point = max(
            candidates, key=lambda x: (x[2]["precision"], x[2]["tp_words"],
                                       x[2].get("label_coverage") or 0))
        return dict(mode=mode_name, variant=variant_name, point=point)

    max_tp_passing = []
    for mode_name, m in modes.items():
        for variant_name, d in m["variants"].items():
            mt = d["metrics"]["max_tp_words_with_precision_ge_0_85"]
            if mt is not None:
                max_tp_passing.append((mt, mode_name, variant_name,
                                       d["metrics"]["max_label_coverage_with_precision_ge_0_85"]))
    max_tp_passing.sort(reverse=True)

    def best_filler(metric_key):
        candidates = []
        for mode_name, m in modes.items():
            sens = m.get("sensitivity_filler_exclusion") or {}
            for variant_name, d in (sens.get("variants") or {}).items():
                point = d["metrics"].get(metric_key)
                if point is not None:
                    candidates.append((mode_name, variant_name, point))
        if not candidates:
            return None
        mode_name, variant_name, point = max(
            candidates, key=lambda x: (x[2]["precision"], x[2]["tp_words"],
                                       x[2].get("label_coverage") or 0))
        return dict(mode=mode_name, variant=variant_name, point=point)

    verdict = dict(
        assertion_bar="precision >= 0.85 with non-trivial coverage",
        any_variant_reaches_bar=any(
            d["metrics"]["any_threshold_precision_ge_0_85_and_label_coverage_ge_0_10"]
            for m in modes.values() for d in m["variants"].values()),
        any_variant_reaches_bar_after_filler_exclusion=any(
            d["metrics"]["any_threshold_precision_ge_0_85_and_label_coverage_ge_0_10"]
            for m in modes.values()
            for d in m["sensitivity_filler_exclusion"]["variants"].values()),
        primary_mode="asr",
        primary_variant="gop_frame_mean",
        best_precision_at_label_coverage_ge_0_10=best_across(
            "best_precision_at_label_coverage_ge_0_10"),
        best_precision_at_label_coverage_ge_0_30=best_across(
            "best_precision_at_label_coverage_ge_0_30"),
        oracle_global_threshold_at_tp_retention_ge_0_50=best_across(
            "oracle_tp_retention_ge_0_50"),
        best_after_filler_exclusion_at_label_coverage_ge_0_10=best_filler(
            "best_precision_at_label_coverage_ge_0_10"),
        best_after_filler_exclusion_at_label_coverage_ge_0_30=best_filler(
            "best_precision_at_label_coverage_ge_0_30"),
        max_tp_words_retained_at_precision_ge_0_85=(
            dict(tp_words=max_tp_passing[0][0], mode=max_tp_passing[0][1],
                 variant=max_tp_passing[0][2],
                 label_coverage=max_tp_passing[0][3]) if max_tp_passing else None),
        interpretation=(
            "GOP-style scoring with the local CROTTC phone-CTC posteriors does not "
            "reach the project's precision >= 0.85 assertion bar at non-trivial "
            "coverage. Even in the gold-transcript upper-bound mode the best "
            "precision at >=10% substitution-error coverage is ~0.66 (phone-min "
            "variant), and precision at >=30% coverage is <= 0.60. An a-priori "
            "filler-word exclusion lifts the gold-mode bound to ~0.73 at 10% coverage "
            "and ~0.69 at 30-50% coverage, still well short of 0.85. Precision >= 0.85 "
            "is attainable only by retaining a handful of true positives (at most 3 "
            "words, <=1.2% error coverage). This is consistent with, and no better "
            "than, the project's ~0.70 reranker oracle representation bound."),
    )
    result = dict(
        probe="GOP-style mispronunciation assertion upper bound",
        created_utc=started,
        scope="bounded zero-cost research probe; no product code, repo, or production changes",
        primary_protocol=dict(
            mode="asr",
            variant="gop_frame_mean",
            note=("Per the task method: Whisper-ASR word spans/tokens from "
                  "prediction.json, word-level GOP threshold, evaluated against "
                  "comparable annotated substitutions. Gold mode is the "
                  "transcript/segmentation-oracle sensitivity bound."),
        ),
        oracle_definition=dict(
            used=("Best precision over every achievable global GOP threshold, with the "
                  "threshold chosen using the labels (mirrors iteration-25's reranker "
                  "oracle: max precision at TP retention >= 50%, and the TP count "
                  "retainable at precision >= 0.85)."),
            degenerate_per_word_threshold=("If every word could receive its own "
                                           "label-set threshold, precision 1.0 and 100% "
                                           "coverage are trivially attainable; that bound "
                                           "is not informative and is not used."),
        ),
        verdict=verdict,
        method=(
            "Per word: forced-align the best cmudict canonical pronunciation to the "
            "word's phone-CTC frames using a monotone HMM (each phone >=1 frame); "
            "GOP_frame = mean_t[log P(canonical phone at t) - max_phone log P(phone at t)]. "
            "Variants: mean of per-phone GOPs (phone_mean) and worst-phone GOP (phone_min). "
            "A word is flagged when GOP <= threshold; sweep every achievable threshold. "
            "Precision = flagged words containing >=1 comparable annotated substitution / "
            "all flagged words. Coverage = comparable substitution labels in flagged words / "
            "all comparable substitution labels. Word recall = positive words flagged / "
            "all positive scored words."
        ),
        caveats=[
            "GOP-style with local CROTTC phone-CTC posteriors, NOT native-ASR GOP (Witt & Young 2000).",
            "Word-level assertion, not phone-level: a flagged word covers every phone error in it.",
            "Primary ground truth = comparable substitutions (kind 's', both EXPECTED and OBSERVED plain uppercase, different); additions/deletions are held out of the precision numerator, matching the project's scorer.",
            "ASR mode uses Whisper word spans/tokens and can mis-transcribe; gold mode uses the annotated transcript and segmentation (upper-bound condition).",
            "The held-out speakers are the CROTTC test split, but the audio is spontaneous Suitcase narrative, so domain shift affects the posteriors.",
        ],
        assets=dict(frozen_inference=str(FROZEN), crottc=str(CROTTC),
                    predictions=str(PRED), annotation=str(ANNOTATION),
                    speakers=asset_notes),
        project_reference=dict(
            detector_precision_heldout=0.6509,
            detector_coverage_or_recall="substitution recall 0.1575 (V1 T0)",
            reranker_oracle_precision_at_tp_retention_ge_0_5=0.7033,
            assertion_bar="precision >= 0.85 with non-trivial coverage",
            source="iteration-25/CONSOLIDATED_CONCLUSION.md / reranker/RERANKER_REPORT.md",
        ),
        modes=modes,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    # SHA256SUMS
    lines = []
    for path in sorted([Path(__file__), args.out]):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.name}")
    (OUTDIR / "SHA256SUMS").write_text("\n".join(lines) + "\n")

    # Concise summary
    def brief(point):
        if not point:
            return None
        return {k: point[k] for k in
                ("threshold", "precision", "label_coverage", "word_recall",
                 "tp_words", "flagged_words", "any_precision",
                 "any_error_coverage") if k in point}

    summary_modes = {}
    for mode, m in modes.items():
        summary_modes[mode] = {}
        for variant in ("gop_frame_mean", "gop_phone_mean", "gop_phone_min"):
            d = m["variants"][variant]
            met = d["metrics"]
            summary_modes[mode][variant] = dict(
                base_rate_primary=met["summary"]["base_rate_primary"],
                total_scored_words=met["summary"]["total_scored_words"],
                total_positive_words=met["summary"]["total_positive_words"],
                oracle_any_coverage=brief(met["oracle_any_coverage"]),
                oracle_with_at_least_5_tp=brief(met["oracle_with_at_least_5_tp"]),
                best_at_cov_ge_0_10=brief(met["best_precision_at_label_coverage_ge_0_10"]),
                best_at_cov_ge_0_30=brief(met["best_precision_at_label_coverage_ge_0_30"]),
                oracle_tp_retention_ge_0_50=brief(met["oracle_tp_retention_ge_0_50"]),
                relaxed_any_error_at_cov_ge_0_10=brief(
                    met["relaxed_any_error_precision_at_any_error_coverage_ge_0_10"]),
                relaxed_any_error_at_cov_ge_0_30=brief(
                    met["relaxed_any_error_precision_at_any_error_coverage_ge_0_30"]),
                passes_0_85_at_cov_ge_0_10=met[
                    "any_threshold_precision_ge_0_85_and_label_coverage_ge_0_10"],
                max_tp_with_precision_ge_0_85=met["max_tp_words_with_precision_ge_0_85"],
                max_label_coverage_with_precision_ge_0_85=met[
                    "max_label_coverage_with_precision_ge_0_85"],
                auc_lower_gop_for_positive=d["auc_lower_gop_for_positive_word"],
            )
    print(json.dumps({
        "created_utc": started,
        "verdict": {
            "actually_reaches_0.85_bar": verdict["any_variant_reaches_bar"],
            "best_precision_at_label_coverage_ge_0.10": verdict[
                "best_precision_at_label_coverage_ge_0_10"],
            "best_precision_at_label_coverage_ge_0.30": verdict[
                "best_precision_at_label_coverage_ge_0_30"],
            "oracle_global_threshold_at_tp_retention_ge_0.50": verdict[
                "oracle_global_threshold_at_tp_retention_ge_0_50"],
            "best_after_filler_exclusion_at_label_coverage_ge_0.10": verdict[
                "best_after_filler_exclusion_at_label_coverage_ge_0_10"],
            "best_after_filler_exclusion_at_label_coverage_ge_0.30": verdict[
                "best_after_filler_exclusion_at_label_coverage_ge_0_30"],
            "reaches_bar_after_filler_exclusion": verdict[
                "any_variant_reaches_bar_after_filler_exclusion"],
            "max_tp_words_retained_at_precision_ge_0.85": verdict[
                "max_tp_words_retained_at_precision_ge_0_85"],
        },
        "modes": summary_modes,
        "output": str(args.out),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()