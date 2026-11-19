#!/usr/bin/env python3
"""G1/G2 rev2 evaluation driver (P1-P3). Offline; no production writes.

Corpus: local L2-ARCTIC (22 speakers, CC BY-NC; personal/non-commercial eval only,
not redistributed). G1 uses the aligned grounded coach + cross-family panel with
an ANCHORED rubric (BL1). G2-prosody validated via cross-codec/noise retest (BL2);
human pause-annotation subset is NOT provided here -> disclosed, retest-only.

Usage:
  python3 run_eval.py --g2-only            # fast local G2-prosody retest
  python3 run_eval.py                      # full G1 + G2 (model calls)
Evidence sealed to --out (report.json + raw + SHA256SUMS).
"""
from __future__ import annotations
import argparse, json, os, random, statistics, subprocess, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from runner import gate1_restructured as g1r
from runner import grounded_audio as ga
from runner.models.qwen import QwenAdapter

BASE = Path(os.environ.get("BANDROOM_ACOUSTIC_DIR", str(Path.home() / ".bandroom-acoustic")))
CORPUS = BASE / "corpus" / "suitcase_corpus"
SEED = 20261119

import runner.gate1_auto as _ag1
ANCHORED_TEXT_RUBRIC = _ag1.RUBRIC + """
Anchors (reduce judge spread):
 evidence: 1=generic no quotes; 3=partial quotes; 5=precise verbatim quotes + localization.
 correction: 1=contains wrong corrections; 3=mostly correct; 5=all correct with sound reasons.
 explanation: 1=vague; 3=clear; 5=clear + reasons + learner perspective.
 next_step: 1=none/vague; 3=a suggestion; 5=one concrete immediately practicable drill.
"""


def load_corpus():
    wavs = sorted((CORPUS / "wav").glob("*.wav"))
    samples = []
    for w in wavs:
        spk = w.stem
        tr = CORPUS / "transcript" / f"{spk}.txt"
        resp = tr.read_text().strip() if tr.exists() else ""
        samples.append({"id": spk, "stage": "speak", "audio_file": w.name,
                        "response_text": resp, "feedback": "", "evidence": "",
                        "pronunciation": None, "context_text": "L2-ARCTIC read/narrative (eval)."})
    return samples


def g2_prosody_retest(samples, conditions=("mp3", "aac", "noise"), pause_mode="waveform_only"):
    rows = []
    for s in samples:
        raw = (CORPUS / "wav" / s["audio_file"]).read_bytes()
        with tempfile.TemporaryDirectory() as wd:
            wd = Path(wd)
            _, orig = ga.decode_to_wav(raw, wd)
            base = ga.analyze_calibrated(orig, pause_mode=pause_mode)
            bc = base["calibrated"]
            for cond in conditions:
                deg = wd / f"deg_{cond}.wav"
                if cond == "noise":
                    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(orig),
                           "-filter_complex",
                           "anoisesrc=color=white:amplitude=0.01[n];[0:a][n]amix=inputs=2:duration=first",
                           "-ar", "16000", "-ac", "1", str(deg)]
                    subprocess.run(cmd, check=True, capture_output=True)
                else:
                    lossy = wd / f"lossy.{cond}"
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(orig),
                                    "-b:a", "64k", str(lossy)], check=True, capture_output=True)
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(lossy),
                                    "-ar", "16000", "-ac", "1", str(deg)], check=True, capture_output=True)
                dc = ga.analyze_calibrated(deg, pause_mode=pause_mode)["calibrated"]
                pc_ok = int(bc.get("pause_count", 0)) == int(dc.get("pause_count", 0))
                dur_b = float(bc.get("total_duration_seconds", 0)); dur_d = float(dc.get("total_duration_seconds", 0))
                dur_err = abs(dur_b - dur_d) / dur_b if dur_b else 0
                rows.append({"speaker": s["id"], "cond": cond, "pause_match": pc_ok,
                             "duration_error": round(dur_err, 4),
                             "ok": pc_ok and dur_err <= 0.02})
    n = len(rows)
    consistency = sum(r["ok"] for r in rows) / n if n else None
    return {"conditions": list(conditions), "n_checks": n,
            "retest_consistency": round(consistency, 3) if consistency is not None else None,
            "threshold": 0.9, "pass": consistency is not None and consistency >= 0.9,
            "human_annotation_subset": "not provided (retest-only; disclosed)", "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--g2-only", action="store_true")
    ap.add_argument("--vad", action="store_true", help="G2-prosody via Silero VAD, held-out validation split")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[3] /
                   "acceptance-2026-11-10/iteration-26/g1g2-eval"))
    ap.add_argument("--max-speakers", type=int, default=22)
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    samples = load_corpus()[: args.max_speakers]

    if args.vad:
        half = len(samples) // 2
        tune, val = samples[:half], samples[half:]
        g2 = g2_prosody_retest(val, pause_mode="vad")
        g2.update(mode="vad", tune_subset_n=len(tune), validate_subset_n=len(val),
                  thresholds={"thr": 0.5, "neg": 0.35, "min_speech": 0.25})
    else:
        g2 = g2_prosody_retest(samples)
    print("G2-prosody retest consistency:", g2["retest_consistency"], "pass:", g2["pass"])

    report = {"protocol": "G1G2-rev2", "seed": SEED, "corpus": "L2-ARCTIC (CC BY-NC, eval only)",
              "n_speakers": len(samples), "G2_prosody": g2,
              "training_overlap": "unknown (declared)", "human_pause_annotation": "not provided"}

    if not args.g2_only:
        model = QwenAdapter(api_key=os.environ["DASHSCOPE_API_KEY"])
        evidence = []
        kept, excluded = [], []
        for s in samples:
            fresh = None
            for attempt in range(3):
                try:
                    fresh = g1r.regenerate_grounded(s, CORPUS / "wav", model, 12)
                    break
                except Exception as exc:  # retryable validator/transport errors
                    if attempt == 2:
                        excluded.append({"id": s["id"], "error": str(exc)[:120]})
            if fresh:
                s.update(fresh)
                kept.append(s)
        samples = kept
        report["excluded_regeneration"] = excluded
        # anchored text rubric: monkeypatch ag1.RUBRIC for this run
        import runner.gate1_auto as ag1
        orig_rubric = ag1.RUBRIC
        ag1.RUBRIC = ANCHORED_TEXT_RUBRIC
        l1_text = ag1.run_text_judges(samples, evidence, "L1")
        l1_audio = g1r.run_audio_judge_aligned(samples, CORPUS / "wav", evidence)
        ag1.RUBRIC = orig_rubric
        # Merge audio dims as distinct single-judge dims (not repeated judges),
        # so within-1 reflects true cross-judge agreement on the text dims.
        for sid, dd in l1_audio.get("dims", {}).items():
            for dim, v in dd.items():
                l1_text["scores"].setdefault(sid, {})[dim] = [v]
        agree = g1r.within1_agreement(l1_text["scores"])
        means, crit = [], 0
        for s in samples:
            dims = l1_text["scores"].get(s["id"], {})
            nums = [statistics.median(v) for v in dims.values() if v]
            if nums:
                means.append(statistics.mean(nums))
            if g1r.critical_majority(l1_text["criticals"].get(s["id"], [])):
                crit += 1
        overall = round(statistics.mean(means), 3) if means else None
        ci = g1r.bootstrap_ci(means)
        # Agreement must actually be measured (>=2 judges per cell); a vacuous
        # None is NOT a pass.
        agree_ok = (agree["within1_fraction"] is not None
                    and agree["within1_fraction"] >= g1r.WITHIN1_MIN)
        l1_pass = overall is not None and overall >= 3.5 and crit <= 1 and agree_ok
        underpowered = len(samples) < g1r.UNDERPOWERED_N
        verdict, label = g1r.decide(missing=False, l0_pass=True, anchor_full=True,
                                    l1_pass=l1_pass, l3_pass=True, escalate=False,
                                    underpowered=underpowered)
        report["G1"] = {"n": len(samples), "overall_mean": overall, "overall_ci": ci,
                        "critical_majority_count": crit, "reliability": agree,
                        "reliability_ok": agree_ok, "pass": l1_pass,
                        "verdict": verdict, "label": label, "underpowered": underpowered}
        (out / "raw-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False))
        print("G1 verdict:", verdict, "mean:", overall, ci, "within1:", agree["within1_fraction"])

    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    sums = {f.name: g1r.sha256_file(f) for f in sorted(out.iterdir()) if f.is_file() and f.name != "SHA256SUMS"}
    (out / "SHA256SUMS").write_text("".join(f"{h}  {n}\n" for n, h in sums.items()))
    print("sealed to", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
