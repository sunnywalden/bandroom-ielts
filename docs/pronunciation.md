# Vocabulary pronunciation

The vocabulary review, revealed recall answer, and current lesson words offer
on-demand American pronunciation. `app/pronunciations.ts` lists the 19 distinct
words in historical vocabulary records and prepared Days 12–16. Each source
was checked against the Merriam-Webster headword pronunciation control and
its `en_us` metadata on 2026-11-09. `compact` uses the first adjective recording
(`compac01`), matching the lesson's adjective rather than the noun.

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
