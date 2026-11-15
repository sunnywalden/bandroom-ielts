# Grounded audio coach — production integration (④-A)

Date: 2026-11-15
Status: **implemented and tested in the working tree; NOT deployed.**
No git write command, no `wrangler`, no launchd change, and no write under
`~/.bandroom-runner-prod/` was performed. The lead deploys.

The research coach evidence remains sealed under
`acceptance-2026-11-10/iteration-25/`; this change only copies code into the
product repository.

## 1. What was built

### Stage A — prosody-only speaking coach (no torch)

New module `runner/grounded_audio.py`, plus a vendored `runner/prosody.py`
(byte-for-byte copy of `iteration-25/prosody/prosody.py` with a provenance
header; source SHA-256 `67d6eb5d…b1937`; body verified identical by `diff`).

Flow of `review_speaking_grounded(raw_bytes, attempt, day, config, model, workdir)`:

1. Write the submitted bytes to a private temp directory.
2. Decode with ffmpeg to **lossless 16 kHz mono PCM s16le WAV**. The lossy mp3
   transcode used by the legacy audio-model path is never used for measurement.
3. Run `runner.prosody.analyze_wav(..., pause_mode="waveform_only",
   include_contour=False)`, then `validate_output_schema()`,
   `calibrated_measurements()`, and `require_measurement()` for every surfaced
   field.
4. Enforce the existing `max_duration_seconds` bound (default 10800 s) so a
   pathological upload cannot consume unbounded prosody CPU.
5. Build an evidence document containing only calibrated values:
   `total_duration_seconds`, `speech_span`, `speech_duration_seconds`,
   `speech_ratio`, `pause_count`, `pause_seconds`, and a timestamped `pauses`
   list (capped at 60 entries for prompt size; truncation is flagged).
   Pitch (`consistency_checked`), WPM/articulation/fillers (uncalibrated with no
   verified human word boundaries), and rhythm/stress proxies are never
   surfaced as measurements.
6. Call the **text** model `qwen3.8-max` via
   `QwenAdapter.complete_grounded()` (plain text, no `response_format=json_object`).
   The call is wrapped as untrusted learner data plus calibrated evidence.
7. Validate the returned Chinese text before writeback:
   - Work format: 一、评估 / 二、精确引文 / 三、建议改写 / 四、修改原因 /
     五、下一步 / 六、建议自听对比（非错误断言）.
   - Exactly one micro-drill section.
   - An explicit “未发现可核实的音素错误” statement.
   - At least one quote from the learner's submitted response when it contains
     English tokens.
   - No assertive phoneme claim (`你读错了`, `发音错误`, `音素错误`, `读成`,
     `发成`, `读作`, `应改为`, `纠正`, `误读`, `错读`, and phone-pair arrows).
   - No pitch/F0/Hz, WPM, rate, or filler value presented as a measurement.
   - No overall Speaking band claim.
   - Self-listening section rules (below).
8. Return a `Feedback` compatible with the existing
   `validate_feedback()` / `feedback_to_tool_args()` writeback path, including a
   structured `Pronunciation`.

The orchestrator path `CoachRunner._review_audio_grounded()` reuses the existing
byte-range recording read, `validate_feedback()`, `feedback_to_tool_args()`, and
`add_coach_feedback` writeback. No new server contract is introduced.

### Stage B — optional detector candidates (torch subprocess, fail-closed)

`collect_self_listen_candidates()` is called only when
`[grounded] self_listen_enabled = true`. It:

- enforces the frozen detector's **5–180 s** range before doing any work;
- resolves the staged script from config (default
  `~/.bandroom-acoustic/frozen-inference.py`), asserts its SHA-256 equals
  `f8e028efe41cf03ec95ffbb76bd38c64e73daaacd7c8229d7bb578df6be6315e`,
  and checks the acoustic venv/models/ffmpeg/whisper assets exist;
- runs the unmodified script with the isolated acoustic venv interpreter and
  `-I`, with a configurable timeout (default 900 s);
- validates the output `sourceSha256`, drops malformed predictions, deduplicates
  `(word, timestamp)`, sorts by detector confidence, and returns at most
  `self_listen_max_n` (default 3) neutral items. Each item is
  `{word, timestamp_ms, seconds, detector_confidence, is_error_assertion: false,
  suggestion_zh}`; no expected/actual phone pair is surfaced.
- caches by audio SHA-256 + frozen-script SHA in
  `~/.bandroom-runner/acoustic-cache` (configurable), so a retry does not re-pay
  ~25 s of inference;
- **returns `[]` on any failure** — missing venv/asset, bad SHA, timeout,
  non-zero exit, malformed JSON, or out-of-range duration. The review continues
  through Stage A with no self-listening items. It never asks an LLM to “listen”
  as a fallback.

The model prompt only receives the candidates; the deterministic validator
requires every English word in section 六 to come from the candidate list, to
have a nearby timestamp, and to avoid assertive phrasing (`你读错了`,
`发音错误`, `应改为`, `读成`, `发成`, `读作`, `纠正`, `误读`, `错读`, …).
At most `self_listen_max_n` words are allowed. With no candidates, section 六
must say “本次没有可自听对比的建议。” and may not invent words.

## 2. Mode precedence

New key: `[runner] coach_audio_mode = "off" | "legacy" | "grounded"`.

Resolution order (implemented in `resolve_coach_audio_mode()`):

1. If `coach_audio_mode` is present in TOML, it wins. Invalid values are a
   `ConfigError`.
2. If the key is absent, the legacy `coach_audio` boolean decides:
   - `true` → `"legacy"` (the existing `qwen3.8-omni-flash` whole-clip path);
   - `false` → `"off"` (skip speaking attempts; text still runs).
3. All shipped config files set `coach_audio_mode = "off"` explicitly, so the
   documented default and production status are off.

`RunnerConfig` constructed directly (tests, dry-run) keeps `coach_audio=True`
and `coach_audio_mode=None`, which resolves to `"legacy"` — exactly the
pre-change behaviour. This is why the existing 63 tests still pass unmodified.

Per mode:

| mode | speaking attempts | path | recording read |
|---|---|---|---|
| `off` | skipped, counted in `audio_held_skipped` | none | no |
| `legacy` | reviewed | `_review_audio` (omni audio model) | yes |
| `grounded` | reviewed | `_review_audio_grounded` (text model + calibrated prosody) | yes |

## 3. No `pronunciation` rating is emitted (lead review correction)

**The first implementation draft sent `band = 0.0` as an "unassessed sentinel".
That was wrong and was removed before deployment.**

Why it was wrong — `lib/coach.ts:107` unconditionally formats the stored band
into the learner-visible evidence string:

```ts
...(row.pronunciation?{evidence:row.evidence+` · 发音专项暂定 ${row.pronunciation.band.toFixed(1)}/9（本次录音）· ${row.pronunciation.observation}`}:{}),
```

So the learner would have seen **「发音专项暂定 0.0/9」** — a fabricated failing
score. `PRONUNCIATION_HINTS_ENABLED = false` (`app/attempt-feedback.tsx:69`) only
hides the experimental error-hint cards; it does **not** gate that band string.
An observation disclaiming the number is not an adequate guardrail when the
number itself is rendered as a score.

**Correct behaviour, and it is what the contract prescribes.** The MCP
`feedbackSpec` marks `pronunciation` `.optional()` and its description says:

> "Optional practice rating only with recordingId, actual audible evidence and
> full-clip listening. **Leave absent for transcripts, metadata, technical
> decoding or text-only clients.** Never aggregate into an overall Speaking band."

The grounded path *is* technical decoding + calibrated DSP, not full-clip phoneme
listening. Therefore:

- `grounded_audio.review_speaking_grounded()` returns `pronunciation=None`
  (`GROUNDED_PRONUNCIATION`);
- the grounded branch of `orchestrator.py` no longer raises
  `pronunciation_missing` — that requirement belongs only to the legacy
  `_review_audio` path, which really does listen to the clip;
- server-side `lib/coach.ts:284` then computes `rating = null`, stores no rating,
  and the `发音专项暂定 X/9` string is never rendered;
- the honest statement「未发现可核实的音素错误」lives in the **feedback text** and
  the evidence string, where it belongs.

**Companion fix — `recordingId` must survive.** `feedback_to_tool_args()` previously
emitted `recordingId` *only* inside the `pronunciation is not None` branch, so
omitting the rating would also have dropped the recording link and broken
click-to-relisten. It now emits `recordingId` whenever
`stage == "speak" and recording_id and audio_used`, independently of the rating.
The MCP schema permits `recordingId` alone (it only rejects `pronunciation`
*without* `recordingId`). Text reviews are unaffected (`audio_used=False`).

Regression tests: `test_grounded_writeback_never_carries_a_band_but_keeps_recording_link`
and `test_text_writeback_still_omits_recording_id`.

No database schema change, no UI change, and no fabricated band.

## 4. TCC staging requirements

Launchd cannot read `~/Documents` on this host (this has bitten the project
before). Therefore:

- the runner code is copied to the runner directory (for example
  `~/.bandroom-runner-prod/runner/`), not executed from `~/Documents`;
- the frozen detector script is copied to a TCC-safe staging directory under
  the home folder, default `~/.bandroom-acoustic/frozen-inference.py`;
- `[grounded] staging_dir` / `detector_script` / `detector_models` /
  `detector_ffmpeg` / `detector_whisper` / `detector_cache_dir` are all
  configurable; the code has **no hard-coded `~/Documents` path** (only
  comments mention it);
- the detector cache/work directory defaults to
  `~/.bandroom-runner/acoustic-cache`, which is writable by the runner user.

## 5. Config reference

Tracked reference: `runner/config.example.toml`. The deployed
`config.prod.toml` / `config.qa.toml` are gitignored deployment files; the
local copies in this checkout were also updated, but the lead must ensure the
deployed file has the keys.

```toml
[runner]
coach_audio_mode = "off"   # "off" | "legacy" | "grounded"
coach_audio = false        # legacy fallback; ignored when the mode key is set

[budget]
grounded_cost_cny = 0.10   # one text-model call per grounded speaking review

[grounded]
# Stage A: production interpreter with NumPy/SciPy; ffmpeg for decode.
acoustic_python = "~/.bandroom-acoustic/env/bin/python"
staging_dir = "~/.bandroom-acoustic"
# Optional explicit overrides; defaults derive from staging_dir:
# detector_script = "~/.bandroom-acoustic/frozen-inference.py"
# detector_models = "~/.bandroom-acoustic/crottc"
# detector_ffmpeg = "~/.bandroom-acoustic/rescued/ffmpeg-pin/ffmpeg"
detector_whisper = "~/.cache/whisper/large-v3-turbo.pt"
detector_timeout_seconds = 900
detector_cache_dir = "~/.bandroom-runner/acoustic-cache"
self_listen_enabled = false
self_listen_max_n = 3
# ffmpeg = "/opt/homebrew/bin/ffmpeg"   # if launchd PATH lacks ffmpeg
```

No secrets are stored in TOML. `DASHSCOPE_API_KEY` and the site service-token
environment variables keep their existing convention.

## 6. Exact deployment steps for the lead

1. **Copy runner code** from this checkout into the deployed runner directory
   (`~/.bandroom-runner-prod/runner/` or the active equivalent):
   - new: `runner/grounded_audio.py`
   - new: `runner/prosody.py`
   - new: `runner/prompts/grounded_audio.txt`
   - modified: `runner/orchestrator.py`
   - modified: `runner/content_rules.py`
   - modified: `runner/models/base.py`
   - modified: `runner/models/qwen.py`
   - modified: `runner/__init__.py`
   Keep the existing `runner/tests/` out of production if that is the current
   convention; they are not imported by the runtime.
2. **Stage the frozen detector outside Documents** (Stage B only):
   ```bash
   cp <acceptance-root>/scripts/frozen-inference.py ~/.bandroom-acoustic/frozen-inference.py
   shasum -a 256 ~/.bandroom-acoustic/frozen-inference.py
   # must equal f8e028efe41cf03ec95ffbb76bd38c64e73daaacd7c8229d7bb578df6be6315e
   ```
   Do **not** edit the frozen script.
3. **Verify the acoustic assets** (Stage B only):
   - `~/.bandroom-acoustic/env/bin/python` (torch/transformers/cmudict/sklearn)
   - `~/.bandroom-acoustic/crottc/` (CROTTC weights + `wavlm/`)
   - `~/.bandroom-acoustic/rescued/ffmpeg-pin/ffmpeg`
   - `~/.cache/whisper/large-v3-turbo.pt`
4. **Edit the deployed config**:
   - set `[runner] coach_audio_mode = "off"` first (current safe state);
   - set `[budget] grounded_cost_cny`;
   - set `[grounded]` paths and `self_listen_enabled = false`;
   - ensure `ffmpeg` is on the launchd PATH or set `[grounded] ffmpeg`.
5. **Pre-flight in the checkout** (production interpreter):
   ```bash
   cd /Users/henry/Documents/Codex/2026-11-08/referenced-chatgpt-conversation-this-is-an/work/bandroom/.sites-checkout
   /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pytest runner/tests -q
   ```
   Expected: `104 passed`.
6. **Enable Stage A only**: set `coach_audio_mode = "grounded"` with
   `self_listen_enabled = false`. Verify in the logs:
   - `run_started` contains `"audioMode": "grounded"`;
   - a speaking attempt emits `recording_reassembled` and
     `grounded_model_usage` (with `usage`);
   - `cost_reserved` has `"kind": "grounded"`;
   - `feedback_saved` is emitted.
7. **Enable Stage B** only after Stage A is healthy: set
   `self_listen_enabled = true`, keep `self_listen_max_n = 3`. Verify:
   - `self_listen_detector_ok` (or `self_listen_cache_hit`);
   - on a broken asset/venv, `self_listen_unavailable` and the review still
     saves through Stage A;
   - the feedback has a `六、建议自听对比（非错误断言）` section with at most
     three candidate words and timestamps.
8. **Rollback**: set `coach_audio_mode = "off"` (or restore the previous
   `coach_audio = false` without a mode). No code rollback is needed. Stage B
   failures self-disable; they do not crash the run.

## 7. Tests (real output)

Baseline before this change:

```text
$ /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pytest runner/tests -q
63 passed in 0.13s
```

After this change:

```text
$ /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m pytest runner/tests -q
104 passed in ~0.8s
```

Composition: the original 63 tests are unchanged and pass; `test_models.py`
gained one grounded-completion request-shape test; the new
`runner/tests/test_grounded_audio.py` contributes 39 tests, and `test_content_rules.py` gained one pronunciation-scope test.

Coverage highlights:

- default/backward-compatible dispatch: `off` skips speaking, legacy
  `coach_audio=true` still uses `_review_audio`, legacy `false` skips;
- mode precedence and invalid-mode rejection;
- calibrated-only evidence; pitch/WPM/filler keys never appear as measurements;
- phoneme-assertion, phone-pair, overall-speaking-band, pitch, and WPM
  rejection; negated disclaimers allowed;
- structured pronunciation object accepted by `validate_feedback()` and
  `feedback_to_tool_args()`;
- Stage B fail-closed on missing venv, bad SHA, out-of-range duration, timeout,
  non-zero exit; cache hit avoids inference; max-N and neutral wording;
- detector SHA assertion;
- self-listening non-hedged word, assertive phrasing, max-N, missing-timestamp,
  and invented-word rejection;
- grounded cost reservation (`grounded_cost_cny`) and legacy-path isolation.

Read-only cross-checks (not modified):

```text
$ cd acceptance-2026-11-10/iteration-25
$ python3 -m unittest discover -s coach/tests -t . -q
Ran 76 tests ... OK

$ python3 -m pytest prosody/tests -q
28 passed
```

Manual Stage A decode check on this host: a 44.1 kHz stereo PCM WAV decoded to
`16000 Hz / 1 channel / 16-bit` with the same 6.0 s duration; the calibrated
pause detector found the synthetic 2.00–2.98 s pause. No paid model call was
made.

## 8. Unverified / known limitations

- **No live text-model call** was made in this task. The `qwen3.8-max` ground
  prompt and parser are unit-tested with fakes and the request shape is tested;
  the real model's compliance rate with the six-section validator is unknown.
  A model output that violates the rules is treated as a retryable
  `ContentRuleError("grounded_feedback_violation")`.
- **No real frozen-detector inference** was run in this task. Stage B's
  command construction, SHA assertion, 5–180 s gate, timeout, non-zero-exit,
  cache, and candidate shaping are unit-tested; the actual end-to-end
  subprocess on a real recording was not exercised here.
- **No deployment or live site call** was made. The server's acceptance of the
  generated `add_coach_feedback` arguments is mirrored from `lib/coach.ts` /
  `lib/content-rules.ts` and existing tests, not verified against production.
- **The UI rendering of `band 0.0/9`** is inferred from `lib/coach.ts`; it was
  not visually verified. The observation text disclaims it.
- **`scope: "partial"`** is carried on the runner-side `Pronunciation` object
  and added again by the server. The runner does not send it through MCP
  because `feedbackSpec` is a strict object; this is verified by reading the
  server code, not by a live write.
- `grounded_cost_cny = 0.10` is a planning estimate, not an invoice amount.
  Stage B inference is local and adds no paid API cost, but costs ~25 s of
  CPU/GPU time per cache miss.
- The detector's held-out precision is 0.6509; the self-listening section is
  therefore explicitly non-assertive. Do not describe it as error detection.
- The `runner/prosody.py` copy is a vendored snapshot. If the research module
  changes, re-vendor it and re-run both test suites; do not edit the copy in
  place.

## 9. Files changed in the working tree

New:

- `runner/grounded_audio.py`
- `runner/prosody.py` (vendored, provenance header)
- `runner/prompts/grounded_audio.txt`
- `runner/tests/test_grounded_audio.py`
- `runner/GROUNDED_AUDIO_INTEGRATION.md` (this file)

Modified:

- `runner/orchestrator.py` (mode config/dispatch, grounded review, cost bucket)
- `runner/content_rules.py` (allow the `grounded_audio` prompt)
- `runner/models/base.py` (optional `complete_grounded` protocol method)
- `runner/models/qwen.py` (plain-text grounded completion + usage capture)
- `runner/__init__.py` (document the lazy Stage A NumPy/SciPy dependency)
- `runner/config.example.toml` (mode, grounded section, budget key)
- `runner/tests/test_models.py` (grounded request-shape test)
- `runner/tests/test_content_rules.py` (partial-scope pronunciation test)

Ignored-but-updated local deployment configs (not part of the tracked diff):
`runner/config.prod.toml`, `runner/config.qa.toml`.