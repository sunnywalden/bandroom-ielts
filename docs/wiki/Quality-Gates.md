# Quality Gates

Bandroom uses a gate model (G1–G5) to decide what may be asserted or enabled. Public summary; detailed acceptance evidence is kept out of the public repo.

- **G1 — blind coaching quality.** Independent blind evaluation of coach feedback against anchors. Requires human annotators / browser corpus.
- **G2 — speaking analysis reliability.** Grounded prosody + detector evidence.
- **G3 — cross-run durability & transport.** Checkpoint save/read, lease renewal, cold==resumed byte equality, receipt idempotence, fence binding. QA-scoped acceptance achieved; formal G3 requires the full contract.
- **G4 — recording / audio integrity.** Codec, range-read, reconstruction, auth boundaries.
- **G5 — formal release signing.** Independent Ed25519 keys, formal identity digest, 24h observation, full M4 timing. An independent project.

## Current status

- Phoneme assertions (T2) globally OFF pending per-category evidence (V3 gates).
- T1 grounded prosody + T3 self-listen shipped and verified end-to-end.
- Observation windows: first full 24h window PASSED (7/7) after instrument fixes; subsequent windows open per production change.
- G1 formal blind test and G5 formal signing remain independent projects requiring owner-provided human/keys resources.
