# Quality Gates

Bandroom uses a gate model (G1–G5) to decide what may be asserted or enabled. Public summary; detailed acceptance evidence is kept out of the public repo.

- **G1 — coaching quality (restructured, G1-R).** Runs **without human annotators**: pre-registered cross-family LLM blind panel (agreement necessary-not-sufficient) + objective anchors carrying validity + optional single-owner spot check as contradiction sanity only. Critical-majority rule; L2 baseline comparison is descriptive (no non-inferiority claim); audio layer not claimed cross-family; underpowered results labelled `[indicative]`; single pre-registered analysis, sealed evidence. A PASS is labelled `G1-automated(machine-panel)` and is **never** a human-blind pass.
- **G2 — speaking analysis reliability.** Grounded prosody + detector evidence.
- **G3 — cross-run durability & transport.** Checkpoint save/read, lease renewal, cold==resumed byte equality, receipt idempotence, fence binding. QA-scoped acceptance achieved; formal G3 requires the full contract.
- **G4 — recording / audio integrity.** Codec, range-read, reconstruction, auth boundaries.
- **G5 — formal release signing.** Independent Ed25519 keys, formal identity digest, 24h observation, full M4 timing. An independent project.

## Current status

- Phoneme assertions (T2) globally OFF pending per-category evidence (V3 gates).
- T1 grounded prosody + T3 self-listen shipped and verified end-to-end.
- Observation windows: first full 24h window PASSED (7/7) after instrument fixes; subsequent windows open per production change.
- G1-R (machine panel) implemented and run; honest verdict **FAIL** on the stale over-claiming eval set (audio weaker than Work, HJK falsified, anchor partial, underpowered) — escalated, not manufactured.
- Remediation B+A (aligned scope): regenerated feedbacks via the shipped grounded coach and judged under an anchored rubric. Final pre-registered run (L2-ARCTIC, n=19 after 3 validator exclusions, disclosed): **G1 PASS** as `G1-automated(machine-panel)` — mean 4.375 (95% CI 4.16–4.58), within-1 0.763 (76 measured cells), 0 critical-majority, not underpowered. Two evaluation bugs (audio-dims aggregation; text-rubric mismatch causing vacuous agreement) were found, fixed, and the invalid interim PASS withdrawn. Fleiss κ 0.065 is descriptive (weak beyond-chance agreement); within-1 is the pre-registered gate. **Not a human-blind pass.** Phoneme assertions remain OFF; personal calibration (C) live.
- G5 formal signing (original four-independent-party contract) remains an independent project requiring owner-provided keys. A reduced-trust **`G5-owner-attested(single-root-four-key)`** local-attestation seal was delivered 2026-11-19 (see below); it is NOT the original multi-party formal G5 and does not certify the original D2 acoustic-quality bar.

## Research & decisions (2026-11-19)

- **Assertion bar 0.85 → 0.70** (owner-directed). Implemented in the V3 gates with a mandatory ~70% reliability disclosure on T2 assertions; pause-calibration reliability (0.85) is unchanged. GOP evidence shows 0.70 is near the representation ceiling, so this does not by itself enable reliable assertions.
- **GOP probe** (local CROTTC phone-CTC posteriors + cmudict, zero cost): deployable ASR protocol best precision 0.60 @ 14% error-coverage; gold-transcript upper bound 0.73 @ 11%; precision ≥0.85 only on 1–3 retained TPs (<1.2% coverage). Per-speaker variance large (txhc at chance). Confirms the limitation is representational, not thresholding — GOP is not a route to high-precision assertion.
- **G2-prosody robustness fix (deployed)**: waveform-only pause detection jittered under noise/aac (retest 0.75–0.79 < 0.9). Added a Silero-VAD pause mode (`pause_mode="vad"`); held-out cross-codec/noise retest = **1.0 ≥ 0.9 → G2-prosody PASS**. Production switched to VAD (fixed validated thresholds; per-user pause multiplier applies to waveform_only only, disclosed).
- **Contrast audio** default TTS upgraded to `qwen-audio-3.0-tts-plus` (native endpoint, still off by default, fail-closed; a TTS call never yields a phoneme claim).
- **qwen-audio-3.0 family**: asr-flash = transcript only; realtime-plus = same-family audio LLM (not an independent judge, weak objective phoneme perception); tts-plus = synthesis for contrast. None closes the phoneme-assertion gap.

## Zero-human closed-loop delivery (2026-11-19, iteration-27)

Owner approved Z-D1…Z-D9 after a two-reviewer closure (69 findings). Delivery is honestly scoped into three loops:

- **Loop B — `G5-owner-attested(single-root-four-key)`** (new namespace `bandroom-d2-local-attestation-v1`, derived tools; frozen formal exporter/verifiers untouched). Four distinct Ed25519 keys generated on one machine, frozen role names kept, `allowed-signers` distributed OUTSIDE the bundle. Local C cold==resumed and D-local byte-equality PASS; fence/writeback four clauses discharged via Miniflare against the real server logic (4/4); `check_local` **40/40, 0 waivers**; verify READY. **Disclosed lost property**: a single compromise can forge all four signatures and a verifying package; trust is public reproducibility + owner attestation, NOT multi-party independence. This is NOT the original four-independent-party formal G5, and it does NOT certify the original D2 acoustic-quality bar (precision 0.9 / recall 0.7 / 10 unseen speakers / 200 errors / 150 ms), which was never met. M4-local is informational (the Work-cloud 300/900 s cold-start schema is architecture-retired).
- **Loop A — T2 personal calibration machinery built, T2 stays OFF.** `V3-P-A` machine-panel gate variant (copies frozen V3-P logic, imports identical constants/helpers; differential hard gate asserts byte-identical human outputs, 80/80; frozen gates byte-unchanged). T2 cannot unlock: production has 2 sessions / 1 future candidate (< frozen floor ≥4 / ≥20), and the CG calibration gate is **deferred** — SpeechOcean762 (acquired, CC BY 4.0) carries per-phone accuracy scores but no substituted-phone identity or time alignment, so CG needs forced alignment + a pre-result preregistration clarification (owner decision). No CG/gate result fabricated; no threshold lowered. The CG prior is unfavorable (detector oracle ceiling 0.7033, dominant class DH→D 0.680, audio-LLM recall 0–1.8%).
- **Loop C — continuous-ops consolidation.** `closed_loop_status.py` read-only fail-closed daily aggregator (window / runner / T2 adequacy / CG / G5 / cost / remaining owner-maintenance items); existing observation evaluator (1800 s) and coach runner (300 s) keep running. Remaining owner-maintenance (credential/key rotation, model-deprecation recalibration) is disclosed, not automated.

Two gate taxonomies are distinguished explicitly: the frozen D2 G0–G5 (platform / data-licence / acoustic-quality / background-closure / page-history / release) vs the public wiki G1–G5 (coaching quality / analysis reliability / cross-run / recording integrity / signing). The original D2-G2 acoustic-quality gate remains FAILED and is not certified by `G5-owner-attested`.
