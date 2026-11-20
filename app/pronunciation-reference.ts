// Reference-audio fallback chain for the self-listening confirmation cards.
//
// The runner's optional DashScope TTS contrast audio is off by default and
// fail-closed, so production sessions usually had no `canonicalAudioUrl` and
// the card could only say "标准发音对比暂不可用". Like the vocabulary section,
// the card now resolves an external reference recording instead, through a
// provenance-labeled chain:
//
//   1. runner-provided model audio (labeled 标准发音, as before);
//   2. the verified Merriam-Webster human recordings shared with vocabulary
//      (`pronunciations.ts`), with Cambridge US IPA and source links;
//   3. for any other single English word, the Youdao dictionary reference
//      audio, labeled 词典参考音 and never described as a human recording;
//   4. non-word tokens keep the timestamp-only honest fallback.
//
// Every tier is a listening reference only: no tier yields a phoneme claim or
// a score, and each says so. Playback is click-to-start (`preload="none"` in
// the player), so no external request happens until the learner presses play,
// and only a gated single-word token is ever sent to an external host.
// See docs/pronunciation.md for provenance and fallback behavior.

import {pronunciations} from './pronunciations.ts';

export type ReferenceAudioKind = 'model' | 'recording' | 'dictionary';

export type ReferenceAudio = {
  kind: ReferenceAudioKind;
  url: string;
  /** Noun used in button/aria labels, e.g. 播放{noun}. */
  noun: string;
  hint: string;
  status: { loading: string; playing: string; error: string };
  sourceLabel?: string;
  sourceUrl?: string;
  ipa?: string;
  ipaSource?: string;
};

export const CONTRAST_UNAVAILABLE_HINT = '标准发音对比暂不可用，仍可回听原录音。';

const SINGLE_WORD = /^[a-z]+(?:['’-][a-z]+)*$/;
const MAX_WORD_LENGTH = 32;

// Only clean single-word tokens may reach an external host: transcript
// fragments, digits, or anything phrase-shaped stay on the honest fallback.
export function normalizedWord(word: string): string | null {
  const key = word.trim().toLowerCase();
  if (!key || key.length > MAX_WORD_LENGTH || !SINGLE_WORD.test(key)) return null;
  return key;
}

export function dictionaryUrlFor(word: string): string | null {
  const key = normalizedWord(word);
  return key ? `https://www.merriam-webster.com/dictionary/${encodeURIComponent(key)}` : null;
}

export function referenceAudioFor(word: string, canonicalAudioUrl?: string): ReferenceAudio | null {
  if (canonicalAudioUrl) {
    return {
      kind: 'model',
      url: canonicalAudioUrl,
      noun: '标准发音',
      hint: '标准发音用于对照，不是评分依据。',
      status: {
        loading: '正在加载标准发音…',
        playing: '正在播放标准发音。',
        error: '标准发音暂时无法播放，可以重试。',
      },
    };
  }
  const key = normalizedWord(word);
  if (!key) return null;
  const recording = Object.hasOwn(pronunciations, key) ? pronunciations[key] : undefined;
  if (recording) {
    return {
      kind: 'recording',
      url: recording.audio,
      noun: '词典真人发音',
      hint: '韦氏词典真人美式录音，用于对照，不是评分依据。',
      status: {
        loading: '正在加载词典发音…',
        playing: '正在播放词典真人发音。',
        error: '词典发音暂时无法播放，可以重试，或打开词典页对照。',
      },
      sourceLabel: '韦氏词典',
      sourceUrl: recording.source,
      ipa: recording.ipa,
      ipaSource: recording.ipaSource,
    };
  }
  return {
    kind: 'dictionary',
    url: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(key)}&type=2`,
    noun: '词典参考音',
    hint: '参考音来自有道词典外部音源，用于对照，不是评分依据。',
    status: {
      loading: '正在加载词典参考音…',
      playing: '正在播放词典参考音。',
      error: '词典参考音暂时无法播放，可以重试，或打开词典页对照。',
    },
    sourceLabel: '有道词典',
    sourceUrl: `https://dict.youdao.com/result?word=${encodeURIComponent(key)}&lang=en`,
  };
}
