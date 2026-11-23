// Shared coaching content rules (design rev2 §4.5, MJ-3). Extracted verbatim
// from the add_coach_feedback path so complete_review_task cannot bypass them.
//
// Realtime upgrade Phase 1 (doc §4.3-1, D2): the rules now apply to EVERY
// stage on the server, not only speaking. Text reviews additionally may not
// carry an IELTS band number (writing bands are not calibrated), and runner
// completions of text tasks must cite the learner's own wording.
export type ContentRuleViolation = {
  code: "overall_speaking_band" | "unstructured_pronunciation" | "uncalibrated_band" | "uncited_evidence";
  message: string;
};

const BAND_NUMBER = "(?:[0-8](?:[.]5|[.]0)?|9(?:[.]0)?)(?![.0-9])";
const OVERALL_SPEAKING = "(?:overall speaking|speaking band|口语总分|口语综合分|口语单科分)";
const PRONUNCIATION = "(?:pronunciation|发音)";
// Any IELTS-style band claim in a text review (writing, reading evidence,
// reflections). Descriptor wording without a number stays allowed.
const TEXT_BAND = "(?:overall|writing|task\\s*[12]|ielts|band|写作|作文|雅思|总分|分数)";

function explicitClaim(claim: string, term: string): boolean {
  return new RegExp(
    term + "(?:\\s*(?:[:：=]|is|was|would be|estimated at|band|score|为|得分|约为|约|暂定|预估|评分|是|为|大约))*\\s*"
      + BAND_NUMBER,
    "i",
  ).test(claim);
}

export function coachingContentViolation(input: {
  feedback: string;
  evidence: string;
  attempt?: string;
  hasStructuredPronunciation?: boolean;
  /** Attempt stage. Omitted = legacy speaking-only call (no text-band rule). */
  stage?: string;
}): ContentRuleViolation | null {
  const claim = [input.feedback, input.evidence, input.attempt ?? ""].join(" ");
  if (explicitClaim(claim, OVERALL_SPEAKING)) {
    return {
      code: "overall_speaking_band",
      message: "A partial classroom answer cannot receive an overall Speaking band. Use a full independent assessment record for that.",
    };
  }
  if (!input.hasStructuredPronunciation && explicitClaim(claim, PRONUNCIATION)) {
    return {
      code: "unstructured_pronunciation",
      message: "Record a pronunciation estimate in the structured pronunciation field only after listening to its submitted clip.",
    };
  }
  if (input.stage !== undefined && input.stage !== "speak" && explicitClaim(claim, TEXT_BAND)) {
    return {
      code: "uncalibrated_band",
      message: "Text reviews may not state an IELTS band number: writing bands are not calibrated. Describe the criterion instead.",
    };
  }
  return null;
}

// Mirrors runner/content_rules.py `_CITATION_WORD`: an English word of 3+
// characters or 2+ CJK characters.
const CITATION_WORD = /[A-Za-z0-9][A-Za-z0-9'_-]{2,}|[一-鿿]{2,}/g;

// Function words carry no citation value: "the answer is good" must not count
// as quoting a draft that happens to contain "the".
const STOPWORDS = new Set(("the a an and or but so of to in on at for with by as from is are was were be been being " +
  "it its this that these those i you he she we they my your his her our their them not no do does did have has had " +
  "will would can could should there here what which who how when where why if than then because about into over " +
  "under very too also just").split(" "));

/** Whole-token match, so "the" inside "other" is not a citation. */
function containsWord(loweredEvidence: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9'_-])${escaped}(?![A-Za-z0-9'_-])`).test(loweredEvidence);
}

/** Evidence must quote at least one concrete token from the learner's answer
 * (an empty or token-free answer cannot be cited and passes). Content words are
 * required when the answer has any; stopword-only answers fall back to a
 * boundary-aware match rather than rejecting every short answer. */
export function citesLearnerText(evidence: string, response: string): boolean {
  const tokens = new Set((response.match(CITATION_WORD) ?? []).map(token => token.toLowerCase()));
  if (!tokens.size) return true;
  const lowered = evidence.toLowerCase();
  const content = [...tokens].filter(token => !STOPWORDS.has(token));
  const candidates = content.length ? content : [...tokens];
  return candidates.some(token => containsWord(lowered, token));
}

export function citationViolation(evidence: string, response: string): ContentRuleViolation | null {
  return citesLearnerText(evidence, response) ? null : {
    code: "uncited_evidence",
    message: "Evidence must quote the learner's own wording so the review is auditable.",
  };
}
