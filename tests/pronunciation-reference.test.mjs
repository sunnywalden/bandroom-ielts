// Pure fallback-chain contract for the self-listening reference audio.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  CONTRAST_UNAVAILABLE_HINT,
  dictionaryUrlFor,
  normalizedWord,
  referenceAudioFor,
} from '../app/pronunciation-reference.ts';
import {pronunciations} from '../app/pronunciations.ts';

test('runner-provided model audio wins over every external fallback', () => {
  const reference = referenceAudioFor('evidence', 'https://fixture.example/model.mp3');
  assert.equal(reference.kind, 'model');
  assert.equal(reference.url, 'https://fixture.example/model.mp3');
  assert.equal(reference.noun, '标准发音');
  // Even a non-word token keeps the server-provided audio.
  assert.equal(referenceAudioFor('um uh', 'https://fixture.example/model.mp3').kind, 'model');
});

test('curated vocabulary words reuse the verified human recording with IPA and source', () => {
  const reference = referenceAudioFor('evidence');
  assert.equal(reference.kind, 'recording');
  assert.equal(reference.url, pronunciations.evidence.audio);
  assert.equal(reference.sourceUrl, pronunciations.evidence.source);
  assert.equal(reference.ipa, pronunciations.evidence.ipa);
  assert.equal(reference.ipaSource, pronunciations.evidence.ipaSource);
  assert.match(reference.hint, /真人/);
});

test('ordinary single words fall back to the external dictionary reference audio', () => {
  const reference = referenceAudioFor('think');
  assert.equal(reference.kind, 'dictionary');
  assert.equal(reference.url, 'https://dict.youdao.com/dictvoice?audio=think&type=2');
  assert.equal(reference.sourceLabel, '有道词典');
  assert.match(reference.sourceUrl, /dict\.youdao\.com/);
  assert.doesNotMatch(reference.hint, /真人/);
});

test('words are normalized before lookup and URL construction', () => {
  assert.equal(normalizedWord(' Think '), 'think');
  assert.equal(referenceAudioFor('EVIDENCE').kind, 'recording');
  assert.equal(referenceAudioFor("don't").url, "https://dict.youdao.com/dictvoice?audio=don't&type=2");
  assert.equal(referenceAudioFor('well-known').kind, 'dictionary');
});

test('only clean single-word tokens may reach an external host', () => {
  for (const word of ['um uh', 'abc123', '', '   ', 'a'.repeat(33), 'hello, world', 'θink']) {
    assert.equal(normalizedWord(word), null, word);
    assert.equal(referenceAudioFor(word), null, word);
    assert.equal(dictionaryUrlFor(word), null, word);
  }
  assert.equal(CONTRAST_UNAVAILABLE_HINT, '标准发音对比暂不可用，仍可回听原录音。');
});

test('dictionary links are gated the same way as audio', () => {
  assert.equal(dictionaryUrlFor('think'), 'https://www.merriam-webster.com/dictionary/think');
});

test('every tier is a listening reference, never a score or a phoneme claim', () => {
  for (const word of ['the', 'evidence', 'think']) {
    const reference = referenceAudioFor(word, word === 'the' ? 'https://fixture.example/m.mp3' : undefined);
    assert.match(reference.hint, /不是评分依据/);
    assert.match(reference.status.error, /重试|对照/);
  }
});
