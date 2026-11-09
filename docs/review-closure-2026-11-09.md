# Review closure — 2026-11-09

Reviewed the speaking submission/recovery workflow, vocabulary review and US
pronunciation, per-attempt feedback, and state/recording ownership boundaries.
All mutations and injected failures in acceptance tests use synthetic accounts.

## Findings resolved

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| A delayed draft acknowledgement could replace newer typing; a changed cloud base could discard a dirty draft on reload. | A shared account/field-scoped external draft store retains dirty edits; only an acknowledgement matching the current draft retires it. | Delayed-save/edit/reload and clean-cloud-update tests; real browser save-delay and reload. |
| In-flight answer edits or duplicate writing clicks could disagree with the submitted snapshot. | Lock answer controls during submission and synchronously guard duplicate writing submissions; ordinary draft saves still allow continued typing. | Failure, delay, double-click and self-review tests. |
| Final reflection was held only in component state. | Persist its local draft by account/day and use the saved reflection once committed. | Reflection reload regression. |
| Feedback authentication errors did not lock the study surface, and a late save could clear an authentication lock. | Validate the feedback response account, lock on 401/403/account mismatch, and permit only an authenticated state read to unlock. Keep the mounted recording/draft surface hidden during recovery. | Account mismatch, late acknowledgement, login recovery and recording retention tests; browser expiry/reconnect. |
| Descriptive attempt labels could bypass exact feedback binding for structured submissions. | Require the current exact attempt ID whenever the stage has structured work; preserve descriptive labels only for historical unstructured records. | Feedback API invalid prefix/label/recording tests; updated real-codec audio acceptance. |
| Attempt hashing failure silently hid feedback and could misclassify exact reviews as legacy. | Show an explicit retryable identification error; classify unmatched feedback only after identification succeeds. | Injected digest failure/retry test. |
| Legacy device recording loading could remain pending, race on repeat clicks, or finish after unmount. | Bound IndexedDB waiting, prevent overlapping loads, ignore late results, and release object URLs. | Lint/type validation and existing recording workflow suite. |
| Changing a pronunciation word used an effect-driven reset. | Remount the player by normalized word so playback/status belong to one word. | Pronunciation playback/error/timeout/unmount tests. |

## Validation

- `npm run test:review`: 48 UI/model/recording tests; 2,460 state API
  assertions; 23 feedback API checks; 39 backup assertions. All passed.
- Real isolated R2 recording recovery and four FFmpeg-decoded codecs passed,
  including ownership, range, metadata and exact review binding checks.
- Browser: draft changes made during delayed saving survived acknowledgement
  and reload; Work feedback appeared beside the submitted first draft without
  replacing the unsent revision; feedback login expiry locked the page and
  reconnect restored the draft and review. Day 12 remained unfinished.
- Lint passed. Type/build and deployment evidence are recorded in the delivery
  report after source publication.

## Deliberate limits

Work grading is started in the current chat. The site displays objective checks
immediately and polls for the exact subjective review; it does not secretly
start a Work task or use a paid AI API. A recording without an actual listening
review does not receive an invented pronunciation score.

Dictionary recordings stream from the verified publisher source. They may be
temporarily unavailable; the UI offers retry and the dictionary link without a
synthetic-voice fallback. Browser storage can be unavailable or cleared, so only
confirmed server submissions are durable across devices.
