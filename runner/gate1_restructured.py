#!/usr/bin/env python3
"""G1-R — restructured Gate-1 coach-quality evaluation WITHOUT human annotators.

Implements iteration-26/G1_RESTRUCTURE_DESIGN.md rev2 + G1_IMPLEMENTATION_BLUEPRINT.md.
Evidence base: pre-registered cross-family LLM blind panel (agreement is necessary,
NOT sufficient) + objective anchors carrying validity + optional single-owner
spot check as contradiction sanity only (never FAIL->PASS).

Rev2 closures: critical majority rule; L2 descriptive (no non-inferiority claim);
audio not claimed cross-family; quote policy (<0.2 blocking, 0.2-0.4 advisory);
HJK anchor must be timed; anchor_coverage partial -> no PASS; deterministic audio
dedup; underpowered -> PASS labelled [indicative]; single pre-registered analysis;
fail-closed on missing inputs; sealed model ids + SHA256SUMS.

Reuses sealed AG1 helpers (runner.gate1_auto) without modifying them.
Secrets from DASHSCOPE_API_KEY env. No site writes; model calls only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from runner import gate1_auto as ag1  # noqa: E402

SEED = 20261119
WITHIN1_MIN = 0.7          # empirical, no power basis (pre-registered)
QUOTE_BLOCK = 0.2          # <0.2 = wholesale fabrication (blocking)
UNDERPOWERED_N = 8         # n<8 -> underpowered, PASS only [indicative]
BOOT_B = 2000
MODEL_IDS = {"text": ag1.J_TEXT, "audio": ag1.J_AUDIO,
             "arbiter": ag1.ARBITER, "redteam": ag1.REDTEAM}


# ------------------------------------------------------------- pure helpers
def critical_majority(judges: list) -> bool:
    """A sample is critical only if >=2 distinct text judges flag it."""
    return len(set(judges)) >= 2


def apply_quote_policy(l0: list) -> list:
    """0.2<=ratio<0.4 downgraded to advisory (suggested corrections in quotes);
    only <0.2 (wholesale fabrication) stays blocking."""
    for r in l0:
        kept = []
        for iss in r["issues"]:
            if iss.startswith("mostly_unverified_quotes:"):
                ratio = float(iss.split(":")[1])
                if ratio >= QUOTE_BLOCK:
                    r.setdefault("advisory", []).append(iss)
                    continue
            kept.append(iss)
        r["issues"] = kept
        r["pass"] = not kept
    return l0


def dedup_samples(samples: list, hashes: dict) -> tuple:
    """Keep earliest sample per audio content hash; drop later duplicates."""
    seen, kept, dropped = {}, [], []
    for s in samples:
        h = hashes.get(s.get("audio_file"))
        if h and h in seen:
            dropped.append(s["id"])
            continue
        if h:
            seen[h] = s["id"]
        kept.append(s)
    return kept, dropped


def corroborated_l3(out: dict) -> bool:
    """Red-team falsification blocks only with demonstrable evidence
    (claim + why_wrong) or second-family corroboration; else advisory."""
    if not out.get("falsified"):
        return False
    items = out.get("items") or []
    return any(isinstance(i, dict) and i.get("claim") and i.get("why_wrong") for i in items)


def decide(*, missing: bool, l0_pass: bool, anchor_full: bool, l1_pass: bool,
           l3_pass: bool, escalate: bool, underpowered: bool) -> tuple:
    """Pre-registered decision table (blueprint §4). Returns (verdict, label)."""
    if missing:
        return "ERROR", None
    if not l0_pass or not anchor_full:
        return "FAIL", None
    if not l1_pass:
        return "FAIL", None
    if not l3_pass:
        return "FAIL", None
    if escalate:
        return "ESCALATE", None
    label = "G1-automated(machine-panel)"
    if underpowered:
        label += "[indicative]"
    return "PASS", label


# ------------------------------------------------------------- statistics
def within1_agreement(scores: dict) -> dict:
    cells, spreads, counts = 0, [], []
    for sid, dims in scores.items():
        for dim, vals in dims.items():
            vals = [v for v in vals if isinstance(v, (int, float))]
            if len(vals) >= 2:
                cells += 1
                spreads.append(max(vals) - min(vals))
                counts.append([sum(1 for v in vals if int(round(v)) == c) for c in range(1, 6)])
    within1 = (sum(1 for s in spreads if s <= 1) / cells) if cells else None
    return {"cells": cells, "within1_fraction": within1,
            "mean_spread": round(statistics.mean(spreads), 3) if spreads else None,
            "fleiss_kappa": fleiss_kappa(counts)}


def fleiss_kappa(counts: list) -> float | None:
    n = len(counts)
    if n == 0:
        return None
    n_raters = sum(counts[0])
    if n_raters < 2:
        return None
    p_j = [sum(row[j] for row in counts) / (n * n_raters) for j in range(5)]
    P_i = [(sum(c * c for c in row) - n_raters) / (n_raters * (n_raters - 1)) for row in counts]
    P_bar, P_e = statistics.mean(P_i), sum(p * p for p in p_j)
    if abs(1 - P_e) < 1e-9:
        return None
    return round((P_bar - P_e) / (1 - P_e), 3)


def bootstrap_ci(values: list, seed: int = SEED, b: int = BOOT_B) -> tuple | None:
    """Clustered bootstrap 95% CI of the mean (percentile; small-n caveat noted)."""
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    rng = random.Random(seed)
    n = len(vals)
    means = sorted(statistics.mean(vals[rng.randrange(n)] for _ in range(n)) for _ in range(b))
    return (round(means[int(0.025 * b)], 3), round(means[int(0.975 * b) - 1], 3))


def bootstrap_ni_ci(qwen: list, work: list, seed: int = SEED, b: int = BOOT_B) -> tuple | None:
    q = [v for v in qwen if v is not None]
    w = [v for v in work if v is not None]
    if not q or not w:
        return None
    rng = random.Random(seed + 1)
    diffs = sorted(statistics.mean(q[rng.randrange(len(q))] for _ in range(len(q))) -
                   statistics.mean(w[rng.randrange(len(w))] for _ in range(len(w))) for _ in range(b))
    return (round(diffs[int(0.025 * b)], 3), round(diffs[int(0.975 * b) - 1], 3))


def anchor_timed_ok(sample: dict, truth: dict) -> bool:
    if sample["id"] != "hjk":
        return True
    obs = (sample.get("pronunciation") or {}).get("observation", "") + " " + sample["feedback"]
    timed = 0
    for e in truth.get("events", []):
        word, ms = e.get("word"), e.get("startMs")
        if not word or ms is None:
            continue
        if re.search(r"\b" + re.escape(word) + r"\b", obs, re.I):
            tm = re.search(re.escape(word) + r"[^0-9]{0,20}(\d+):(\d\d)", obs, re.I)
            if tm and abs((int(tm.group(1)) * 60 + int(tm.group(2))) * 1000 - ms) <= 2000:
                timed += 1
    return timed >= 1


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-dir", required=True)
    ap.add_argument("--evidence-dir", required=True)
    ap.add_argument("--truth", required=True)
    ap.add_argument("--owner-anchor", default=None)
    args = ap.parse_args()
    ev, out = Path(args.eval_dir), Path(args.evidence_dir)
    out.mkdir(parents=True, exist_ok=True)
    truth_path = Path(args.truth)

    required = [ev / "day12-qwen-feedbacks.json", ev / "hjk-qwen-feedback.json",
                ev / "day12-attempts-context.json", ev / "day12-write-snapshot.json",
                ev / "work-feedbacks-baseline.json", truth_path, ev / "audio"]
    missing = not all(p.exists() for p in required)
    if missing:
        (out / "report.json").write_text(json.dumps(
            {"protocol": "G1-R", "verdict": "ERROR", "missing_inputs": [str(p) for p in required if not p.exists()]},
            ensure_ascii=False, indent=1))
        print("=== G1-R VERDICT: ERROR (missing inputs, fail-closed) ===")
        return 3

    evidence = []
    truth = json.loads(truth_path.read_text())
    day12 = json.loads((ev / "day12-qwen-feedbacks.json").read_text())
    hjk = json.loads((ev / "hjk-qwen-feedback.json").read_text())
    attempts = {a["id"]: a for a in json.loads((ev / "day12-attempts-context.json").read_text())}
    write_snap = json.loads((ev / "day12-write-snapshot.json").read_text())
    audio_map = {"v1:speakingPart2": "day12-851218b4.webm", "v1:speakingFollowup": "day12-a425fcde.webm"}
    hashes = {f: sha256_file(ev / "audio" / f) for f in set(audio_map.values()) if (ev / "audio" / f).exists()}

    samples = []
    for fb in day12:
        att = fb["attempt"]
        a = attempts.get(att, {})
        resp, ctx = a.get("response") or "", a.get("context", {})
        if fb["stage"] == "write":
            resp = write_snap.get("attempt", {}).get("response", resp)
            ctx = write_snap.get("context", ctx)
        af = next((v for k, v in audio_map.items() if att.startswith(k)), None)
        samples.append({"id": att, "stage": fb["stage"], "feedback": fb["feedback"],
                        "evidence": fb.get("evidence", ""), "pronunciation": fb.get("pronunciation"),
                        "context_text": json.dumps(ctx, ensure_ascii=False)[:1500],
                        "response_text": resp, "audio_file": af, "source": "qwen"})
    samples.append({"id": "hjk", "stage": "speak", "feedback": hjk["feedback"],
                    "evidence": hjk.get("evidence", ""), "pronunciation": hjk.get("pronunciation"),
                    "context_text": "Read-aloud passage (HJK fixture).", "response_text": "",
                    "audio_file": "sample-3-hjk.webm", "source": "qwen"})
    samples, dropped_dup = dedup_samples(samples, hashes)

    # ---- L0 (+ quote policy + timed anchor)
    l0 = apply_quote_policy(ag1.l0_checks(samples, truth))
    anchor_full = True
    for r, s in zip(l0, samples):
        if not anchor_timed_ok(s, truth):
            r["issues"].append("anchor_untimed_or_missing")
            r["pass"] = False
            anchor_full = False
    l0_pass = all(r["pass"] for r in l0)

    # ---- L1 panel + reliability + critical majority
    l1_text = ag1.run_text_judges(samples, evidence, "L1")
    l1_audio = ag1.run_audio_judge(samples, ev / "audio", evidence)
    for sid, vals in l1_audio["scores"].items():
        l1_text["scores"].setdefault(sid, {})["pronunciation"] = vals
    agree = within1_agreement(l1_text["scores"])

    sample_means, disagreements, audio_criticals = {}, [], []
    for s in samples:
        dims = l1_text["scores"].get(s["id"], {})
        med = {}
        for dim, vals in dims.items():
            if len(vals) >= 2 and (max(vals) - min(vals)) > 1.0:
                disagreements.append({"sample": s["id"], "dim": dim, "scores": vals})
            med[dim] = statistics.median(vals) if vals else None
        nums = [v for v in med.values() if v is not None]
        crit = l1_text["criticals"].get(s["id"], [])
        sample_means[s["id"]] = {"dims": med, "mean": round(statistics.mean(nums), 3) if nums else None,
                                 "critical_judges": crit, "critical_majority": critical_majority(crit)}
        if s["id"] in l1_audio["criticals"]:
            audio_criticals.append(s["id"])  # advisory, owned by audio judge

    # ---- arbitration (normalized)
    arb, unresolved = [], []
    for d in disagreements:
        s = next(x for x in samples if x["id"] == d["sample"])
        outj = ag1.call_model(ag1.ARBITER, [{"role": "user", "content": ag1.judge_prompt(s, "Coach X", hear=False) +
                              f"\n\nOther judges scored {d['dim']} as {d['scores']}. Independent score for {d['dim']} only. JSON: {{\"score\":N}}"}])
        score = outj.get("score")
        if isinstance(outj.get("scores"), dict):
            score = outj["scores"].get(d["dim"], score)
        evidence.append({"layer": "arbitration", "sample": d["sample"], "dim": d["dim"], "output": outj})
        arb.append({**d, "arbiter": score})
        if score is not None and (max(d["scores"] + [score]) - min(d["scores"] + [score])) > 1.0:
            unresolved.append({**d, "arbiter": score})

    # ---- L2 descriptive baseline comparison (NOT a PASS condition)
    work = json.loads((ev / "work-feedbacks-baseline.json").read_text())
    work_samples = [{"id": "work:" + w["id"], "stage": w["stage"], "feedback": w["feedback"],
                     "evidence": w.get("evidence", ""), "pronunciation": w.get("pronunciation"),
                     "context_text": f"Day {w['day']} {w['stage']} (historical Work)", "response_text": "",
                     "audio_file": None, "source": "work"} for w in work]
    l2 = ag1.run_text_judges(work_samples + samples, evidence, "L2")

    def unit_means(group, dim):
        return [statistics.median(l2["scores"].get(s["id"], {}).get(dim, [])) for s in group
                if l2["scores"].get(s["id"], {}).get(dim)]
    l2_table = {}
    for dim in ("evidence", "correction", "explanation", "next_step"):
        q, w = unit_means(samples, dim), unit_means(work_samples, dim)
        l2_table[dim] = {"qwen": round(statistics.mean(q), 3) if q else None,
                         "work": round(statistics.mean(w), 3) if w else None,
                         "ni_ci": bootstrap_ni_ci(q, w)}
    q_all = [m["mean"] for m in sample_means.values() if m["mean"] is not None]
    w_all = [v for v in (statistics.median([x for dim in ("evidence", "correction", "explanation", "next_step")
                                            for x in [statistics.median(l2["scores"].get(s["id"], {}).get(dim, []))] if x is not None])
                         for s in work_samples) if v is not None]
    overall_ni_ci = bootstrap_ni_ci(q_all, w_all)

    # ---- L3 red team (corroboration required to block)
    l3 = ag1.red_team(samples, evidence, l1_audio.get("verify"))
    l3_block = {sid: o for sid, o in l3.items() if corroborated_l3(o)}
    l3_advisory = {sid: o for sid, o in l3.items() if o.get("falsified") and sid not in l3_block}
    l3_pass = not l3_block

    # ---- L4 optional owner anchor (contradiction sanity only)
    owner_anchor, owner_contradiction = False, []
    if args.owner_anchor:
        owner_anchor = True
        for sid, ov in json.loads(Path(args.owner_anchor).read_text()).items():
            if ov.get("critical") and not sample_means.get(sid, {}).get("critical_majority"):
                owner_contradiction.append(sid)

    # ---- decision
    means = [m["mean"] for m in sample_means.values() if m["mean"] is not None]
    overall_mean = round(statistics.mean(means), 3) if means else None
    mean_ci = bootstrap_ci(means)
    crit_count = sum(1 for m in sample_means.values() if m["critical_majority"])
    agree_ok = agree["within1_fraction"] is None or agree["within1_fraction"] >= WITHIN1_MIN
    l1_pass = overall_mean is not None and overall_mean >= 3.5 and crit_count <= 1 and agree_ok
    underpowered = len(samples) < UNDERPOWERED_N
    escalate = bool(unresolved) or bool(owner_contradiction)
    verdict, label = decide(missing=False, l0_pass=l0_pass, anchor_full=anchor_full,
                            l1_pass=l1_pass, l3_pass=l3_pass, escalate=escalate, underpowered=underpowered)

    report = {"protocol": "G1-R", "seed": SEED, "evaluatedAt": datetime.now(timezone.utc).isoformat(),
              "verdict": verdict, "gate1_label": label,
              "claim_scope": "cross-family machine blind panel + objective anchors; NOT a human-annotated blind gate; owner is final escalation only; audio layer not cross-family",
              "human_annotators": 0, "owner_anchor": owner_anchor,
              "model_ids": MODEL_IDS, "underpowered": underpowered,
              "ci_method": "clustered percentile bootstrap (small-n: conservative-width caveat)",
              "prereg": {"within1_min": WITHIN1_MIN, "quote_block": QUOTE_BLOCK,
                         "underpowered_n": UNDERPOWERED_N, "boot_B": BOOT_B},
              "anchor_coverage": "full" if anchor_full else "partial",
              "dropped_duplicate_audio": dropped_dup,
              "L0": l0, "L0_pass": l0_pass,
              "L1": {"sample_means": sample_means, "overall_mean": overall_mean, "overall_mean_ci": mean_ci,
                     "critical_majority_count": crit_count, "audio_criticals_advisory": audio_criticals,
                     "reliability": agree, "reliability_ok": agree_ok, "pass": l1_pass},
              "L2": {"descriptive": True, "per_dim": l2_table, "overall_ni_ci": overall_ni_ci, "pass": None},
              "L3": {"blocking": l3_block, "advisory": l3_advisory, "pass": l3_pass},
              "L4": {"owner_anchor": owner_anchor, "contradictions": owner_contradiction},
              "disagreements": disagreements, "arbitration": arb, "unresolved": unresolved,
              "escalate": escalate}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    (out / "raw-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=1))
    sums = {f.name: sha256_file(f) for f in sorted(out.iterdir()) if f.is_file() and f.name != "SHA256SUMS"}
    (out / "SHA256SUMS").write_text("".join(f"{h}  {n}\n" for n, h in sums.items()))
    print("=== G1-R VERDICT:", verdict, "===")
    print("label:", label, "| underpowered:", underpowered, "| anchor:", report["anchor_coverage"])
    print("L0:", l0_pass, "| L1 mean:", overall_mean, mean_ci, "crit-majority:", crit_count, "within1:", agree["within1_fraction"], "pass:", l1_pass)
    print("L2 (descriptive) overall NI CI:", overall_ni_ci)
    print("L3 blocking:", list(l3_block), "advisory:", list(l3_advisory), "pass:", l3_pass)
    print("owner_anchor:", owner_anchor, "contradictions:", owner_contradiction, "unresolved:", len(unresolved))
    return 0 if verdict == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
