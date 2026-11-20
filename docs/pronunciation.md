# Vocabulary pronunciation

The vocabulary review, revealed recall answer, and current lesson words offer
on-demand American pronunciation. `app/pronunciations.ts` lists the 19 distinct
words in historical vocabulary records and prepared Days 12–16. Each source
was checked against the Merriam-Webster headword pronunciation control and
its `en_us` metadata on 2026-11-09. `compact` uses the first adjective recording
(`compac01`), matching the lesson's adjective rather than the noun.

Each of these words also displays the Cambridge Dictionary US IPA transcription
beside its playback button. The IPA itself links to Cambridge's corresponding
pronunciation page; this source is separate from the Merriam-Webster recording.
Transcriptions were checked against the US entries on 2026-11-09, including the
adjective stress in `compact` and the verb stress in `overlook`. Do not substitute
Merriam-Webster's dictionary-specific pronunciation spelling for IPA. Add a
verified US IPA entry and its source along with each new recording.

Merriam-Webster describes its dictionary audio as real English speakers,
not text-to-speech robots, in its publisher-owned app description:
https://play.google.com/store/apps/details?id=com.merriamwebster
Its official documentation defines the US audio URL format:
https://dictionaryapi.com/products/json#sec-2.prs
Word-specific source pages are stored beside each audio URL and linked next
to each play button. Recordings stream from Merriam-Webster's original host;
the project does not copy, proxy, redistribute, or claim an open license for
these recordings. No speech synthesis, generated speech, API key, or paid API
is used. Availability of the external recording host remains outside our control.

Playback starts only after a click, permits replay, and stops the previous word.
Failure or a 12-second stalled load shows an explanation and retry; the original
dictionary page remains available. Unmount stops playback. Unknown words in
future coach-authored lesson packs show a dictionary link and an explicit
missing-recording note. Add a verified US recording when adding vocabulary;
never guess an audio path or substitute synthetic speech. This UI does not
write learning state or reveal a recall answer before the learner checks it.

Validation: `pnpm run test:pronunciation`, the existing `test:review` suite,
TypeScript checking, and the isolated browser fixture. The fixture route
`/__fixture/pronunciations` renders all recordings for real playback checks.
Its audio failure and delay controls apply only to the local test page.

## Coach contrast reference audio (self-listening confirmation)

The speaking coach's confirmation cards previously depended only on the
runner's optional DashScope TTS contrast audio (`runner/contrast_audio.py`,
off by default and fail-closed), so production sessions usually showed
"标准发音对比暂不可用，仍可回听原录音。". The cards now resolve reference
audio through a provenance-labeled fallback chain
(`app/pronunciation-reference.ts`, rendered by `CanonicalContrastPlayer`):

1. Runner-provided model audio (`canonicalAudioUrl`), labeled 标准发音 as
   before, with the existing "用于对照，不是评分依据" disclosure.
2. The verified Merriam-Webster human recordings from `pronunciations.ts`
   (the same entries as vocabulary), labeled 词典真人发音, with the Cambridge
   US IPA link and the word's Merriam-Webster source page beside the buttons.
3. For any other single English word, the Youdao dictionary reference audio
   (`https://dict.youdao.com/dictvoice?audio=<word>&type=2`, US), labeled
   词典参考音 with a link to the Youdao entry. It is an external dictionary
   source and is never described as a human recording.
4. Non-word tokens (phrases, digits, over-long strings) keep the
   timestamp-only honest fallback and never contact an external host.

Every tier states 用于对照，不是评分依据; no tier produces a phoneme claim or
a score, and the T2 assertion gates are untouched. Playback is click-to-start
(`preload="none"`), so no external request happens until the learner presses
play, and only a gated single-word token (lowercased letters with internal
apostrophes/hyphens, at most 32 characters) is sent to an external host. A
failed load shows an honest retry message plus the dictionary page; the
original recording clip remains available throughout. Catch trials resolve
the same chain from the same word, so they stay indistinguishable from real
candidates.

Validation: `pnpm run test:pronunciation` (includes
`tests/pronunciation-reference.test.mjs`), `pnpm run test:pronunciation-coach`
(mounted UI tests for each tier, the failure path, and catch-trial
indistinguishability), and TypeScript checking.
