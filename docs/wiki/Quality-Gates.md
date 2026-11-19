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
- G5 formal signing remains an independent project requiring owner-provided keys.

## Research & decisions (2026-11-19)

- **Assertion bar 0.85 → 0.70** (owner-directed). Implemented in the V3 gates with a mandatory ~70% reliability disclosure on T2 assertions; pause-calibration reliability (0.85) is unchanged. GOP evidence shows 0.70 is near the representation ceiling, so this does not by itself enable reliable assertions.
- **GOP probe** (local CROTTC phone-CTC posteriors + cmudict, zero cost): deployable ASR protocol best precision 0.60 @ 14% error-coverage; gold-transcript upper bound 0.73 @ 11%; precision ≥0.85 only on 1–3 retained TPs (<1.2% coverage). Per-speaker variance large (txhc at chance). Confirms the limitation is representational, not thresholding — GOP is not a route to high-precision assertion.
- **G2-prosody robustness fix (deployed)**: waveform-only pause detection jittered under noise/aac (retest 0.75–0.79 < 0.9). Added a Silero-VAD pause mode (`pause_mode="vad"`); held-out cross-codec/noise retest = **1.0 ≥ 0.9 → G2-prosody PASS**. Production switched to VAD (fixed validated thresholds; per-user pause multiplier applies to waveform_only only, disclosed).
- **Contrast audio** default TTS upgraded to `qwen-audio-3.0-tts-plus` (native endpoint, still off by default, fail-closed; a TTS call never yields a phoneme claim).
- **qwen-audio-3.0 family**: asr-flash = transcript only; realtime-plus = same-family audio LLM (not an independent judge, weak objective phoneme perception); tts-plus = synthesis for contrast. None closes the phoneme-assertion gap.
