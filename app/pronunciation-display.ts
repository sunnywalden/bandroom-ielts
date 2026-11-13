// Precision-first display policy for pronunciation hints. Only substitution
// events with calibrated confidence may be shown; the full analysis remains
// available to reviewers, but the page must not present low-confidence events
// as corrections.
import type {PronunciationError} from './feedback-model';

export const MAX_PRONUNCIATION_HINTS = 5;
export const MIN_PRONUNCIATION_PROBABILITY = 0.5;

export function displayPronunciationErrors(
  errors: PronunciationError[] | undefined,
): PronunciationError[] {
  if (!errors?.length) return [];
  return errors
    .filter(error => error.kind === 'substitution'
      && typeof error.probability === 'number'
      && error.probability >= MIN_PRONUNCIATION_PROBABILITY)
    .sort((left, right) => (right.probability ?? 0) - (left.probability ?? 0)
      || (left.startMs ?? left.anchorMs ?? 0) - (right.startMs ?? right.anchorMs ?? 0))
    .slice(0, MAX_PRONUNCIATION_HINTS);
}
