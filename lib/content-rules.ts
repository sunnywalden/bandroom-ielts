// Shared coaching content rules (design rev2 §4.5, MJ-3). Extracted verbatim
// from the add_coach_feedback path so complete_review_task cannot bypass them.
export type ContentRuleViolation = {
  code: "overall_speaking_band" | "unstructured_pronunciation";
  message: string;
};

const BAND_NUMBER = "(?:[0-8](?:[.]5|[.]0)?|9(?:[.]0)?)(?![.0-9])";
const OVERALL_SPEAKING = "(?:overall speaking|speaking band|口语总分|口语综合分|口语单科分)";
const PRONUNCIATION = "(?:pronunciation|发音)";

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
  return null;
}