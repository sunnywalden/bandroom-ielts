# Pronunciation Coaching

## Why a honesty contract

Extensive measurement showed that phoneme-level error assertions are not reliable enough to assert: detector precision ~0.65, reranker oracle upper bound ~0.70, LLM cascades no better, and fine-tuning below baseline. Rather than over-claim, Bandroom ships a **three-tier contract**. Phoneme assertions (T2) were **formally retired** (owner 2026-11-19): for a single low-volume user the evidence floor (≥4 sessions / ≥20 future candidates) may never accumulate, and the precision ceiling is independent of data volume — so T2 is structurally unreachable, a permanent posture rather than a future unlock. The shipped product is T1 (calibrated prosody) + T3 (self-listen suggestions); the personal-calibration machinery remains as versioned research tooling, not a product promise.

## The three tiers

- **T1 — calibrated prosody.** Pause/duration metrics that are measured and calibrated; assertions allowed, with a per-user reliability disclosure. Personal pause thresholds are clamped and only lowered under a collapse guard.
- **T2 — historically-confirmed categories.** Suggestions conditioned on the learner's own confirmed history ("your history shows…"), never asserted as ground truth. **Owner amendment 2026-11-19:** the assertion bar was lowered 0.85 → **0.70** (Wilson 95% lower bound ≥ 0.70). At this bar ~30% of assertions may be wrong, so every T2 assertion is history-conditioned AND carries a mandatory ~70% reliability disclosure ("以自听对比为准"), never presented as certain. No class passes today.
- **T3 — uncalibrated suggestions.** Self-listen contrast against canonical audio; explicitly *not* error assertions.

T2/T3 are rendered by **deterministic templates**, not model prose, with adversarial guards so T3 can never masquerade as T1/T2.

## Calibration data layer

Migration `0007` adds `personal_calibration`, `calibration_candidates`, `calibration_events`. The server issues `candidateId`s; verdicts are idempotent (`UNIQUE(user,attempt,candidate)`); events are rebuildable in a single batch. Catch trials (`expected===actual`) never count toward class progress; a constant-confirmer rule (≥5 answered, ≥80% confirmed) excludes non-discriminating listeners.

## V3 gates (dual)

- **V3-G (cross-user):** product-level claim / default-on for new users; requires ≥6 users. Frozen, unchanged.
- **V3-P (personal):** single-user; unlocks T2 **for that user only** using their own cross-session evidence (≥2 historical + ≥2 future sessions, session-consistency). Imports V3-G's constants/statistics verbatim — thresholds are not lowered.

## Profile UI

`app/pronunciation-coach.tsx` shows per-class confirmation progress (confirmations only), discloses 「不确定」 and 「其实没错」 (rejected) counts without counting them, a per-minute candidate-rate chart (display-policy invariant, point estimates until CIs exist), reliability disclosure, and a reset that keeps recordings/backups.
