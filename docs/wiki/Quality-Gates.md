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
- G1-R (machine panel) implemented and run; current honest verdict **FAIL** (audio coach weaker than the Work baseline, HJK anchor falsified, anchor coverage partial, underpowered) — escalated, not manufactured into a pass. A human-annotated blind claim still requires humans and is out of scope.
- G5 formal signing remains an independent project requiring owner-provided keys.
