# Phoneme-assertion research probes

Bounded, honest probes of whether phoneme-level error **assertions** are supportable.
Conclusions: `PROBE_CONCLUSIONS.md`; compact metrics: `PROBE_METRICS.json`.

## Scripts
- `gop_probe.py` — GOP-style scoring with local CROTTC phone-CTC posteriors + cmudict.
  Reuses `frozen-inference.py` helpers (canonical pronunciations) without loading the model
  when `*.frames.npz` posteriors are present. No network.
- `realtime_probe.py` — `qwen-audio-3.0-realtime-plus` focused-clip perception via the
  DashScope **WebSocket** realtime API (REST is unsupported for this model). Reads
  `DASHSCOPE_API_KEY` from `~/.config/bandroom/credentials.env`; never prints it.

## Environment
- `BANDROOM_ACOUSTIC_DIR` (default `~/.bandroom-acoustic`) — assets: `crottc/`,
  `frozen-inference.py`, `predictions22/*.frames.npz`, labeled held-out set.
- `BANDROOM_REPO` (default: repo root inferred from this file) — fixtures/truth.

Assets (model weights, L2-ARCTIC audio, frames) are **not** redistributed here
(L2-ARCTIC CC BY-NC; CROTTC weights license unmarked). Obtain them separately per their
licenses; the probes fail closed when assets are missing.

## Status
Both probes conclude phoneme assertions are **not** reliably supportable with current
assets (see conclusions). These are research tools, not part of the production coach.
