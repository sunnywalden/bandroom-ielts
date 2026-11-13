import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  MAX_PRONUNCIATION_HINTS,
  MIN_PRONUNCIATION_PROBABILITY,
  displayPronunciationErrors,
} from '../app/pronunciation-display.ts';

const hint = (overrides = {}) => ({
  wordIndex: 0, phoneIndex: 0, kind: 'substitution', target: 'TH', actual: 'S',
  word: 'think', startMs: 1000, endMs: 1100, probability: 0.9, ...overrides,
});

test('only calibrated substitutions are eligible for display', () => {
  const errors = [
    hint(),
    hint({ kind: 'deletion', actual: '∅', probability: 0.99 }),
    hint({ kind: 'addition', target: '∅', actual: 'AH', probability: 0.99 }),
    hint({ probability: MIN_PRONUNCIATION_PROBABILITY - 0.01 }),
    hint({ probability: undefined }),
    hint({ probability: null }),
  ];
  const shown = displayPronunciationErrors(errors);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'substitution');
});

test('display is capped and sorted by calibrated confidence then start time', () => {
  const errors = Array.from({ length: 8 }, (_, index) => hint({
    word: `word-${index}`,
    probability: 0.6 + index * 0.04,
    startMs: 2000 - index * 100,
    endMs: 2100 - index * 100,
  }));
  errors.push(hint({ word: 'tie-late', probability: 0.9, startMs: 4000, endMs: 4100 }));
  errors.push(hint({ word: 'tie-early', probability: 0.9, startMs: 3000, endMs: 3100 }));
  const shown = displayPronunciationErrors(errors);
  assert.equal(shown.length, MAX_PRONUNCIATION_HINTS);
  for (let index = 1; index < shown.length; index += 1) {
    const previous = shown[index - 1], current = shown[index];
    assert.ok(previous.probability >= current.probability);
    if (previous.probability === current.probability) assert.ok(previous.startMs < current.startMs);
  }
  assert.deepEqual(shown.slice(0, 2).map(error => error.word), ['tie-early', 'tie-late']);
});

test('empty and missing analysis yields no hints', () => {
  assert.deepEqual(displayPronunciationErrors(undefined), []);
  assert.deepEqual(displayPronunciationErrors([]), []);
});
