# Grounded tier gate — runner side (T1 / T2 / T3)

Date: 2026-11-15.
Status: **implemented and tested in the working tree; NOT deployed.**
No `git` write command, no `wrangler`, no launchd change, and no write under
`~/.bandroom-runner-prod/` was performed. The lead deploys after verification.

This document covers the runner-side implementation of design rev2
(`AUDIO_COACH_REFACTOR_DESIGN_rev2.md`) for FIX-4, FIX-5, FIX-7, FIX-18,
FIX-20, FIX-23, FIX-26, FIX-29 and mn-02/mn-03. It supersedes the tier,
timeout and calibration sections of `GROUNDED_AUDIO_INTEGRATION.md`; the Stage A
decode/prosody mechanics there are unchanged.

---

## 1. Tier contract

| Tier | Content | Runner wording rule | Provenance required | Shipped default |
| --- | --- | --- | --- | --- |
| **T1** | Calibrated pause/timing measurements | Statable, but every review carries the per-user reliability disclosure | `prosody.require_measurement()` (`status == "calibrated"`) | **on** |
| **T2** | Items from the user's confirmed history | Assertive wording **allowed only inside the deterministic T2 block**; subject to an allow-list | word + differing phone pair + timestamp + non-empty provenance | `phoneme_assertions_enabled = false` (T2 re-rendered as hedged T3) |
| **T3** | New, uncalibrated detector candidates | Hedged self-listening only; assertive wording rejected | word + timestamp | `self_listen_enabled = false` until the lead flips it |

The explicit assertion gate from the design is unchanged: a phoneme assertion
requires the class's Wilson 95% lower bound to be >= 0.85 with a minimum sample.
**No class passes today**, so the production flag stays false. The runner
enforces the structural consequence of that gate; it does **not** recompute the
per-class Wilson gate for T2 (the allow-list is assumed to arrive from the
server-side personal-calibration workstream after that gate — see §9).

### T1 reliability disclosure

`review_speaking_grounded()` always appends a deterministic line:

```text
【T1 可靠性披露】本次停顿检测阈值倍数 1.60（来源：default_insufficient_labels）。
本人精确率尚未测量；总体精确率 0.8124，逐用户范围 0.333–1.000。
本次检测到 N 个停顿，该计数仅供参考，可能包含误检。
阈值下调的收益是在同一段录音内测得的 headroom，尚未验证跨会话泛化。
```

This fixes the production example that asserted "36 pauses" on a speaker whose
measured pause precision is 0.650: the macro P 0.8124 hides a per-speaker range
of 0.333–1.000, and the learner is told so. The evidence document sent to the
model also carries `t1_reliability` (calibration state, multiplier, Wilson CI
when available, population macro/range, and the within-recording caveat).

### No-error statement

* T2 empty: `未发现可核实的音素错误` is required (unchanged).
* T2 non-empty: the composer deterministically rewrites it to
  `未发现其他可核实的音素错误`; omitting it is also allowed. The unqualified
  statement is rejected (`missing_other_no_error_qualifier`).

### Portrait (FIX-20)

Section 七 is `你的发音画像（建议性质）`, generated deterministically. It
contains no "强项"/"优势" block: an error-pair profile cannot derive strengths,
and `SUPPRESSED` is not evidence of correctness. A portrait containing either
term is rejected (`profile_strengths_claim`).

---

## 2. Why templates, not prose (FIX-5 / BL-E)

The review proved that a regex over free prose cannot enforce "T3 never
masquerades as T2". A T3 word placed in section 一 and written as
"20.31 秒处的 the 听起来接近 /d/" escapes every existing prose check.

The runner therefore separates **who writes what**:

1. The model writes only sections 一–五 (assessment, exact quote, rewrite,
   reasons, exactly one micro-drill). Any model-written section 六/七 is
   discarded.
2. The runner fills section 六 (T3), the optional T2 block inside section 七,
   the portrait, and the T1 disclosure from structured data:
   `classify_candidates()` → `render_t3_section()` / `render_t2_block()` /
   `render_portrait()` → `compose_grounded_feedback()`.
3. `validate_grounded_feedback()` then validates per section and per word:
   * assertive wording in the model-written T1 prose → rejected;
   * assertive wording in the T3 section → `self_listen_assertive_phrasing`;
   * assertive wording in the T2 block → allowed only when the nearest English
     word is an allow-listed T2 word and any phone pair is an allow-listed pair
     (`t2_assertive_not_allowlisted`, `t2_phone_pair_not_allowlisted`);
   * a T3 word in the T1 prose carrying a timestamp or IPA notation →
     `t3_word_outside_t3_section` / `ipa_notation_outside_tier_section`
     (learner quotes are exempt);
   * a T3 word inside the T2 block → `t2_word_not_allowed`;
   * a T2 word in the T1 prose with a timestamp/IPA → `t2_word_outside_t2_section`.

### `PHONEME_ASSERTIONS_ENABLED` (mn-03)

`[grounded] phoneme_assertions_enabled` now exists on the production
`GroundedConfig` (default `false`). When false, valid T2 items are **re-rendered**
as hedged T3 lines (`在 X.XX 秒处的 <word>，可对比标准读音自听判断。`), not
silently dropped and never asserted. Tests assert the same input produces T2
wording when the flag is true and hedged T3 wording when it is false.

### Adversarial coverage

`runner/tests/test_tier_gate.py` covers:

* T2 wording accepted in the T2 block and rejected when moved to section 一;
* assertive T3 wording rejected;
* a T3 word phrased as a T2 claim rejected (with timestamp/IPA, and with a
  hedged "听起来像" claim that has no timestamp);
* a T3 word inserted into the T2 block rejected;
* template determinism (stable ordering by timestamp then word);
* T2 provenance requirements and downgrade behaviour;
* flag-off re-render.

---

## 3. Per-user pause calibration (FIX-7 / FIX-29 / §4.6)

### Measured headroom (lead measurement, authoritative match rule)

Match rule: overlap >= 50% of the reference pause **or** midpoint within
reference ±0.10 s (`calibrate.annotation_pauses` + `calibrate.score_pauses`).
Sweeping `PAUSE_LOW_NOISE_MULTIPLIER` downward with high = low × 3.0:

| speaker | global 1.6 | personal best | gain | optimal m |
| --- | ---: | ---: | ---: | ---: |
| njs | 0.650 | 0.765 | +0.115 | 1.4 |
| tni | 0.640 | 0.750 | +0.110 | 1.0 |
| aba | 0.333 | 0.400 | +0.067 | 1.2 |
| txhc | 0.786 | 0.840 | +0.054 | 1.4 |
| tlv / ykwk / zhaa | already optimal | — | +0.000 | 1.6 |
| hjk | no setting reaches recall >= 0.90 | — | — | — |

Mean gain **+0.0494** (n=7). The optimum is speaker-specific: that is the
personalisation signal. Raising the multiplier **increases** detections (more
frames count as silence); the useful direction is downward. Below roughly 0.8
the detector collapses to zero detections, so the valid range is **[0.9, 1.6]**.

**Honest limit, carried in code, documents and the learner-facing disclosure:**
one recording per speaker. This is **within-recording headroom**, not
cross-session generalisation. No claim of cross-session benefit is made.

**Why pauses and not phonemes:** a learner can correctly judge a 6-second pause
by ear, so pause confirmation labels are trustworthy in this domain. Phoneme
judgements are not: review BL-H showed that even `qwen3.5-omni-plus` confidently
mis-hears phonemes, so an "I confirm" label on a phoneme is much weaker
evidence than one on a pause.

### Algorithm (`runner/pause_calibration.py`)

* Default multiplier **1.6** (the shipped calibrated constant).
* Fewer than `MIN_LABELS = 5` usable pause verdicts → keep the default.
* With enough verdicts, compute the user's confirmed precision and its Wilson
  95% interval. Lower the multiplier only when even the **upper** bound is
  below `TARGET_PRECISION = 0.85` (i.e. there is evidence of low precision, not
  merely a small sample):

  ```text
  m = clamp(1.6 - ((0.85 - wilson_upper) / 0.85) * (1.6 - 0.9), 0.9, 1.6)
  ```

  Using the lower bound instead would lower the threshold for a user with 5/5
  confirmations simply because the sample is small, which is backwards.
* `clamp_multiplier()` enforces `>= COLLAPSE_FLOOR = 0.9` and `<= 1.6`; NaN and
  malformed values fall back to 1.6.
* The multiplier is threaded into the vendored detector via a new optional
  `pause_low_noise_multiplier` keyword on `prosody.detect_pauses()` /
  `prosody.analyze_wav()` and `grounded_audio.analyze_calibrated()`. The
  default is unchanged, so all existing callers behave exactly as before.

### Where confirmations come from

`review_speaking_grounded()` reads optional `attempt["pauseConfirmations"]` (or
`pauseVerdicts`) and an optional `attempt["userId"]` (default `"owner"`). With a
configured `state_dir`, verdicts are appended to
`<state_dir>/pause_calibration.json`, deduplicated by `candidateId`, capped at
500 per user, mode 0600. The server does not yet emit these fields — see §9.

### Reliability estimate in the evidence document

`reliability_document()` produces:

```json
{
  "multiplier": 1.2,
  "multiplierSource": "learned",
  "validRange": [0.9, 1.6],
  "collapseFloor": 0.9,
  "collapseGuarded": true,
  "labels": 8,
  "confirmations": 1,
  "rejections": 7,
  "userPrecision": 0.125,
  "userPrecisionWilson95": [0.022, 0.470],
  "populationMacroPrecision": 0.8124,
  "populationSpeakerPrecisionRange": [0.333, 1.0],
  "withinRecordingOnly": true,
  "pauseCountInThisRecording": 3,
  "caveat": "The multiplier headroom was measured within one recording per speaker; cross-session generalisation is unverified."
}
```

---

## 4. Stage B and canonical contrast audio (FIX-18 / MJ-08)

* `[grounded] self_listen_enabled` remains **false** by default. When the lead
  flips it, T3 is now **actually delivered**: the T3 section is rendered from
  the candidate list by the runner, so the model can no longer omit it or
  render "本次没有可自听对比的建议" while candidates exist. The failure mode
  remains fail-closed: any detector asset/SHA/timeout/parse failure returns
  `[]` and the review still completes through Stage A.
* `[grounded] contrast_audio_enabled` is **false** by default. When enabled,
  `runner/contrast_audio.py` calls the **native** DashScope multimodal endpoint
  (the OpenAI-compatible `/audio/speech` returns 404 for this model):

  ```text
  POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
  {"model": "qwen3-tts-flash", "input": {"text": "<word>", "voice": "Cherry"}}
  -> output.audio.url
  ```

  It is fail-closed: disabled, missing API key, transport error, non-200,
  malformed payload or missing URL all yield `status="unavailable"` and leave
  the timestamp-only wording intact. Tests inject a transport and never touch
  the network. The canonical URL is attached to the T3 item in the evidence
  document; it is never used to derive a phoneme claim.

### What the lead must flip (all default off)

```toml
[model]
grounded_text_timeout_seconds = 240   # 240-300

[grounded]
self_listen_enabled = true            # deliver T3
phoneme_assertions_enabled = false    # keep false until the 0.85 gate passes
contrast_audio_enabled = false        # optional TTS reference
```

---

## 5. Grounded timeout (FIX-23 / MJ-13)

The research build measured grounded feedback latency at **77–162 s**, so the
shared `text_timeout = 120 s` produced tail failures. The grounded path now has
its own budget:

* `[model] grounded_text_timeout_seconds`, default **240 s**, validated to
  **[240, 300] s** at config load (`ConfigError` otherwise).
* `review_speaking_grounded()` passes it to `complete_grounded(..., timeout=...)`
  (signature-aware, so legacy fakes with a two-argument method still work).
* Other text paths keep `text_timeout_seconds = 120`; the legacy audio path
  keeps 240.

**p95 must be measured on the deployed runner before the lead enables the
grounded mode.** This change removes the known tail cause; it does not by
itself prove a p95. The regression tests assert the default 240, a configured
300, rejection of 120, and that the adapter receives the explicit timeout.

---

## 6. L7 / L8 corrections

### FIX-20 — no strengths

See §1. The portrait is deterministic and contains no strengths block; the
validator rejects `强项`/`优势` in it.

### FIX-26 — showing-policy-invariant progress

`runner/progress_metrics.py` implements **candidate occurrences of one class per
minute of speech**, with a Wilson 95% interval:

```python
per_class_candidate_rate(candidates=6, speech_seconds=120.0)
# rate_per_minute = 3.0, CI from the Wilson interval over seconds of exposure
per_class_candidate_rates([...])   # per-class aggregation, ignores shown/nShown
```

The withdrawn metrics are explicitly rejected:
`validate_progress_metric()` raises `ProgressMetricError` for `posterior`,
`posterior_delta`, `rejection_ratio`, `rejection_rate`, `confirm_rate`, etc.
`compare_rates()` returns a delta and interval overlap but states that it is
**not validated as progress**; the design requires validation against an
independent measure before the word "progress" may be used.

Tests show the rate is invariant to `shown`/`nShown`, does not multiply speech
exposure for repeated occurrences, and widens with less exposure.

### mn-02 — correct prosody API

`prosody.is_calibrated()` does not exist. Use:

```python
prosody.require_measurement(envelope)          # raises for non-calibrated
envelope["status"] == prosody.STATUS_CALIBRATED
```

The runner already used `require_measurement()` and
`calibrated_measurements()`; no code referenced the non-existent function. This
document records the correct API so future pseudocode does not reintroduce it.

---

## 7. Config reference (new/changed keys)

```toml
[model]
text_timeout_seconds = 120              # unchanged for non-grounded text
grounded_text_timeout_seconds = 240     # NEW: 240-300, grounded only

[grounded]
self_listen_enabled = false             # Stage B / T3 delivery
self_listen_max_n = 3
phoneme_assertions_enabled = false      # NEW: T2 gate
contrast_audio_enabled = false          # NEW: canonical TTS, fail-closed
contrast_audio_timeout_seconds = 60     # NEW
pause_calibration_default_multiplier = 1.6  # NEW; clamped to [0.9, 1.6]
detector_cache_dir = "~/.bandroom-runner/acoustic-cache"
```

`GroundedConfig.from_mapping()` rejects unknown `[grounded]` keys, so a typo
fails closed rather than being silently ignored.

---

## 8. Tests and exact reproduction commands

### Commands

```bash
cd /Users/henry/Documents/Codex/2026-11-08/referenced-chatgpt-conversation-this-is-an/work/bandroom/.sites-checkout

# Full runner suite (baseline before this change: 106 passed)
/Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pytest runner/tests -q

# New tests only
/Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pytest \
  runner/tests/test_tier_gate.py \
  runner/tests/test_pause_calibration.py \
  runner/tests/test_progress_metrics.py -q

# Compile check
/Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m compileall -q runner
```

### Real results on this working tree

```text
$ /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pytest runner/tests -q
157 passed in 1.78s
```

Before this change the same command reported `106 passed in 0.87s`. The 51
new tests are distributed as:

| file | tests | covers |
| --- | ---: | --- |
| `runner/tests/test_tier_gate.py` | 33 | FIX-4 both directions, FIX-5 adversarial/templates, mn-03 re-render, FIX-7 disclosure, FIX-18 T3 delivery + canonical audio, FIX-20 strengths, FIX-23 timeout |
| `runner/tests/test_pause_calibration.py` | 11 | default-until-enough, bounds, collapse guard, Wilson, store dedupe/persistence, multiplier threaded into detection, evidence document, end-to-end review |
| `runner/tests/test_progress_metrics.py` | 7 | rate unit, CI widening, showing-policy invariance, exposure handling, confounded-metric rejection, no "progress" claim |

All 106 pre-existing tests pass unmodified. In particular, the legacy
`validate_grounded_feedback()` behaviour (no tier arguments) is byte-for-byte
compatible: only callers that pass tier arguments switch to structural
validation.

---

## 9. Unverified / known limitations (honest)

1. **No live model call.** The grounded prompt, composer and validator are
   unit-tested with fakes; the real `qwen3.8-max` compliance rate with the
   "only sections 一–五" instruction is unknown. A model that writes extra
   sections has them discarded; a model that omits a required T1 section is a
   retryable `grounded_feedback_violation`.
2. **The T2 source is not wired to the server.** The runner accepts optional
   `attempt["t2Candidates"]` with word/phone-pair/timestamp/provenance. The
   server-side `personal_calibration` / `calibration_candidates` workstream must
   supply that field after the per-class Wilson 0.85 gate. Until then T2 is
   always empty in production.
3. **The runner does not recompute the Wilson assertion gate.** It trusts the
   allow-list's provenance. The gate must be enforced where the allow-list is
   built (server side), or T2 could be populated incorrectly.
4. **Pause calibration is a heuristic, not a validated mechanism.** It follows
   the direction of the measured within-recording headroom, but the label-based
   learner has not been validated on real multi-session confirmations. The
   headroom table is one recording per speaker; cross-session generalisation is
   unverified.
5. **Pause verdict delivery is not implemented server-side.** The runner reads
   optional fields and persists them locally; no server event exists yet.
6. **Canonical TTS was not called live in this task.** The request shape and
   native endpoint follow the research E3 probe; tests inject a transport.
   API key handling, URL expiry and cost are not exercised here.
7. **Timeouts:** p95 was not measured in this task. The 240–300 s budget is
   config-driven but must be verified on the deployed runner before enabling.
8. **Stage B was not run end-to-end** against the frozen detector in this task;
   its SHA/asset/timeout/cache/fail-closed paths remain unit-tested.
9. **Progress metric** is implemented and invariant, but has not been validated
   against an independent measure. It is not called "progress" anywhere.
10. **Single-owner only.** No multi-user authz, consent, retention or deletion
    work is included; design rev2 §0.4/§10 still blocks a second user on P5.
11. **No deployment.** Nothing was copied to `~/.bandroom-runner-prod/` and no
    launchd/wrangler command was run.
12. **Residual prose risk for non-candidates.** The structural gate rejects
    explicit assertive wording anywhere in T1 prose and rejects a *candidate*
    word (T2 or T3) used with a timestamp, IPA notation or a hedged
    "听起来像" claim outside its section. A hedged phoneme comment about a word
    that appears in no tier at all is not structurally detectable; the prompt
    forbids it, and the server-side contract must not accept unknown phoneme
    claims. This is narrower than the pre-rev2 "regex over free prose" gap but
    not zero.

---

## 10. Files changed in the working tree

New:

* `runner/pause_calibration.py`
* `runner/contrast_audio.py`
* `runner/progress_metrics.py`
* `runner/tests/test_tier_gate.py`
* `runner/tests/test_pause_calibration.py`
* `runner/tests/test_progress_metrics.py`
* `runner/GROUNDED_TIER_GATE.md` (this file)

Modified:

* `runner/grounded_audio.py` — tier dataclasses/classification, deterministic
  templates, tier-aware validator, reliability disclosure, calibration wiring,
  contrast audio, grounded timeout pass-through, config keys
* `runner/prosody.py` — optional `pause_low_noise_multiplier` keyword on
  `detect_pauses()` / `analyze_wav()`; default unchanged
* `runner/orchestrator.py` — `grounded_text_timeout` config + 240–300 validation
* `runner/prompts/grounded_audio.txt` — model writes only sections 一–五;
  T2/T3/portrait/disclosure are system-generated
* `runner/config.example.toml` — new timeout and grounded flags
* `runner/config.prod.toml`, `runner/config.qa.toml` — local deployment copies
  updated (gitignored; the lead must ensure the deployed copies have the keys)

Read-only cross-checks (not modified): the sealed evidence under
`acceptance-2026-11-10/iteration-*/`, including
`~/.bandroom-acoustic/PAUSE_HEADROOM_REDO2.json`.