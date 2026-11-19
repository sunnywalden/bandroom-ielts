# Phoneme-assertion probes — conclusions (2026-11-19)

Two zero/low-cost probes tested whether any available route can support **phoneme-level
error assertions** at the project's reliability bar. Both conclude **no**; the limitation
is representational, not a thresholding artifact. Full sealed evidence lives outside the
repo (`~/.bandroom-acoustic/{gop_probe,realtime_probe}/`); `PROBE_METRICS.json` here is the
compact, path-free summary.

## GOP probe (`gop_probe.py`)
GOP-style scoring (Witt & Young 2000) using the **local CROTTC phone-CTC posteriors +
cmudict** (not a native-ASR GOP), forced-aligned per word; three variants (frame-mean,
phone-mean, phone-min); ASR (Whisper spans) and gold-transcript modes.

- Deployable ASR protocol: best precision **0.60 @ 14.4%** substitution-error coverage;
  **0.485 @ 30%**; oracle (TP-retention ≥50%) **0.481**.
- Gold-transcript upper bound: **0.73 @ 10.7%** (with a-priori filler exclusion); still
  never 0.85 at non-trivial coverage.
- Precision ≥0.85 retains only **1–3 true positives (<1.2% coverage)**.
- Per-speaker variance large; txhc at chance (AUC ≈0.51).
- **Conclusion:** GOP with the local model does not reach the assertion bar; consistent
  with the ~0.70 reranker-oracle representation bound.

## Realtime-plus probe (`realtime_probe.py`)
`qwen-audio-3.0-realtime-plus` focused-clip perception, pre-registered (16 errors + 16
controls, 2 repeats, 64 calls), neutral prompt, canonical supplied.

- **REST not supported** (HTTP 400); WebSocket realtime only.
- Strict (correct target→actual): **precision 0 / recall 0**.
- Loose (any deviation): recall **12.5%**, precision ~57%; control false-positives **9.4%**.
- Audio path validated (word overlap 1.0) → misses are perception, not transport.
- **Conclusion:** no material improvement over prior F1; not usable as detector/asserter
  at 0.70 or 0.85. Same Qwen family as the coach → cannot be an independent judge.

## Combined implication
No open-source / LLM / GOP route reliably supports phoneme assertions with current assets.
The honest posture remains: T1 calibrated prosody + T3 hedged self-listen; phoneme
assertions gated (owner bar 0.70 with mandatory ~70% disclosure) and effectively off until
per-class evidence passes; personalization accumulates via the calibration loop (C).
A phoneme-level commercial option (Azure) exists but is out of scope (cost/licensing).

## Reproduce
See README.md. Scripts are env-driven (`BANDROOM_ACOUSTIC_DIR`, `BANDROOM_REPO`); they read
`DASHSCOPE_API_KEY` from the private credentials file and never print it. Assets (weights,
corpus, frames) are NOT distributed here (L2-ARCTIC CC BY-NC; weights license unmarked).
