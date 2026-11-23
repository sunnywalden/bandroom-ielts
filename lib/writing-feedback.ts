// Writing issue cards + incremental second-draft review
// (docs/experience-upgrade-realtime-feedback-revision-2026-11-22.md §4.4, §4.6, §4.8).
//
// Server-side contract for the `writing` field of complete_review_task. The
// model supplies quotes, never offsets: anchors are resolved here against the
// immutable submitted text. Unresolvable anchors are kept as general advice
// (anchor = null), never placed at an invented position. Second-draft
// verdicts are checked against a deterministic word diff: an anchor whose
// words are all unchanged is always `untouched`, and a `resolved`/`partial`
// verdict must quote the second draft verbatim.
import { z } from "zod/v4";
import { containsQuote, resolveAnchor, trackAnchors, type Span } from "@/app/writing-diff";
import { coachingContentViolation } from "./content-rules";

export const WRITING_SCHEMA = "bandroom-writing-feedback-v1";
export const WRITING_FIELDS = new Set(["writeOriginal", "writeRevision"]);
/** Snapshot field of a "我改好了吗？" quick-check task (lib/writing-recheck.ts). */
export const RECHECK_FIELD = "writeRecheck";

export type WritingCategory = "TR" | "CC" | "LR" | "GRA";
export type WritingPriority = "must" | "should" | "nice";
export type WritingIssue = {
  id: string; category: WritingCategory; priority: WritingPriority;
  quote: string; anchor: Span | null;
  prompt_zh: string; why_zh: string; suggestion: string | null;
};
export type WritingVerdict = {
  issue: string; result: "resolved" | "partial" | "unresolved" | "untouched";
  evidence_quote: string | null; why_zh: string;
  /** Deterministic diff state of the issue's anchor (null = no anchor). */
  local: "untouched" | "changed" | null;
  /** True when the server overrode the model's verdict (honesty rules). */
  adjusted: boolean;
};
export type WritingCards = {
  schema: typeof WRITING_SCHEMA; mode: "cards";
  issues: WritingIssue[];
  summary: { priorities: string[]; next_step_zh: string };
};
export type WritingDelta = {
  schema: typeof WRITING_SCHEMA; mode: "delta";
  baseFeedbackId: string | null;
  verdicts: WritingVerdict[];
  issues: WritingIssue[];
  summary: { carry_forward_zh: string };
};
/** Single-issue quick check during the second draft (doc §4.5). Advisory:
 * the incremental review after submission remains the verdict of record. */
export type WritingRecheck = {
  schema: typeof WRITING_SCHEMA; mode: "recheck";
  baseFeedbackId: string; issue: string;
  result: "resolved" | "partial" | "unresolved";
  evidence_quote: string | null; why_zh: string; adjusted: boolean;
};
export type WritingFeedback = WritingCards | WritingDelta | WritingRecheck;

const text = (max: number) => z.string().trim().min(1).max(max);
const issueSpec = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,16}$/),
  category: z.enum(["TR", "CC", "LR", "GRA"]),
  priority: z.enum(["must", "should", "nice"]),
  quote: text(300),
  context_before: z.string().max(200).optional().nullable(),
  prompt_zh: text(300),
  why_zh: text(600),
  suggestion: z.string().trim().max(400).optional().nullable(),
});
const cardsSpec = z.object({
  mode: z.literal("cards"),
  issues: z.array(issueSpec).min(1).max(12),
  summary: z.object({
    priorities: z.array(z.string().trim().max(16)).max(4).default([]),
    next_step_zh: text(300),
  }),
});
const deltaSpec = z.object({
  mode: z.literal("delta"),
  verdicts: z.array(z.object({
    issue: z.string().trim().max(16),
    result: z.enum(["resolved", "partial", "unresolved", "untouched"]),
    evidence_quote: z.string().max(300).optional().nullable(),
    why_zh: text(600),
  })).max(12),
  issues: z.array(issueSpec).max(8).default([]),
  summary: z.object({ carry_forward_zh: text(300) }),
});

const recheckSpec = z.object({
  mode: z.literal("recheck"),
  result: z.enum(["resolved", "partial", "unresolved"]),
  evidence_quote: z.string().max(300).optional().nullable(),
  why_zh: text(400),
});

export class WritingFeedbackError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function checkRules(strings: string[]) {
  const violation = coachingContentViolation({ feedback: strings.join(" "), evidence: "", stage: "write" });
  if (violation) throw new WritingFeedbackError("content_rule_violation", violation.message);
}

function normalizeIssues(raw: z.infer<typeof issueSpec>[], response: string): WritingIssue[] {
  const seen = new Set<string>();
  return raw.map(issue => {
    if (seen.has(issue.id)) throw new WritingFeedbackError("invalid_writing", `duplicate issue id ${issue.id}`);
    seen.add(issue.id);
    // Argument and structure are coached by direction only: never a rewrite.
    const hintOnly = issue.category === "TR" || issue.category === "CC";
    return {
      id: issue.id, category: issue.category, priority: issue.priority,
      quote: issue.quote,
      anchor: resolveAnchor(response, issue.quote, issue.context_before ?? ""),
      prompt_zh: issue.prompt_zh, why_zh: issue.why_zh,
      suggestion: hintOnly ? null : (issue.suggestion?.trim() || null),
    };
  });
}

function parse<T>(spec: z.ZodType<T>, raw: unknown): T {
  const result = spec.safeParse(raw);
  if (!result.success) throw new WritingFeedbackError("invalid_writing", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500));
  return result.data;
}

/** First draft: validate cards and resolve anchors against the submitted text. */
export function validateWritingCards(raw: unknown, response: string): WritingCards {
  const input = parse(cardsSpec, raw);
  const issues = normalizeIssues(input.issues, response);
  const ids = new Set(issues.map(issue => issue.id));
  const priorities = [...new Set(input.summary.priorities)].filter(id => ids.has(id)).slice(0, 2);
  const result: WritingCards = {
    schema: WRITING_SCHEMA, mode: "cards", issues,
    summary: { priorities, next_step_zh: input.summary.next_step_zh },
  };
  checkRules([...issues.flatMap(i => [i.prompt_zh, i.why_zh, i.suggestion ?? ""]), result.summary.next_step_zh]);
  return result;
}

export type FirstReview = { feedbackId: string; issues: WritingIssue[] };

/**
 * Second draft: verdicts per first-draft issue + new issues.
 * `firstDraft` and `firstReview` come from the immutable snapshot frozen at
 * submission time (never from the runner).
 */
export function validateWritingDelta(raw: unknown, revision: string, firstDraft: string,
  firstReview: FirstReview): WritingDelta {
  const input = parse(deltaSpec, raw);
  const byId = new Map(firstReview.issues.map(issue => [issue.id, issue]));
  const anchored = firstReview.issues.filter(issue => issue.anchor);
  const tracked = trackAnchors(firstDraft, revision, anchored.map(i => i.anchor as Span));
  const states = new Map(anchored.map((issue, index) => [issue.id, tracked[index].state]));
  const seen = new Set<string>();
  const verdicts: WritingVerdict[] = [];
  for (const verdict of input.verdicts) {
    if (!byId.has(verdict.issue) || seen.has(verdict.issue)) continue; // unknown/duplicate ids are dropped
    seen.add(verdict.issue);
    const local = states.get(verdict.issue) ?? null;
    const quote = verdict.evidence_quote?.trim() || null;
    const cited = Boolean(quote && containsQuote(revision, quote));
    let result = verdict.result, adjusted = false, override: string | null = null;
    if (local === "untouched" && result !== "untouched") {
      result = "untouched"; adjusted = true;
      override = "这一处在二稿中没有改动。";
    } else if (local === "changed" && result === "untouched") {
      result = "unresolved"; adjusted = true;
      override = "这一处在二稿中有改动,但还不能据此判定改好了。";
    }
    if ((result === "resolved" || result === "partial") && !cited) {
      result = "unresolved"; adjusted = true;
      override = "复核结论缺少可逐字核对的二稿原文引用,因此不能判定为已解决。";
    }
    // When the server overrides the model, its rationale is replaced too:
    // storing "已解决" prose next to an `untouched` verdict would contradict the
    // structured result in every legacy reader (history, MCP, exports).
    verdicts.push({ issue: verdict.issue, result, evidence_quote: cited ? quote : null,
      why_zh: override ?? verdict.why_zh, local, adjusted });
  }
  // EVERY first-draft issue gets a verdict, not just the untouched ones: an
  // edited issue the model simply omitted must not vanish from the reflection
  // page. A missing verdict is reported as unassessed, never as a pass.
  for (const issue of firstReview.issues) {
    if (seen.has(issue.id)) continue;
    const local = states.get(issue.id) ?? null;
    if (local === "untouched") {
      verdicts.push({ issue: issue.id, result: "untouched", evidence_quote: null,
        why_zh: "这一处在二稿中没有改动。", local, adjusted: true });
    } else {
      verdicts.push({ issue: issue.id, result: "unresolved", evidence_quote: null,
        why_zh: local === "changed"
          ? "这一处你做了修改,但本次复核没有给出结论,请自行核对。"
          : "本次复核没有评估这一处,请自行核对。",
        local, adjusted: true });
    }
  }
  const issues = normalizeIssues(input.issues.map(issue => ({ ...issue, id: issue.id.startsWith("n") ? issue.id : "n" + issue.id })), revision);
  const result: WritingDelta = {
    schema: WRITING_SCHEMA, mode: "delta", baseFeedbackId: firstReview.feedbackId,
    verdicts, issues, summary: { carry_forward_zh: input.summary.carry_forward_zh },
  };
  checkRules([...verdicts.map(v => v.why_zh), ...issues.flatMap(i => [i.prompt_zh, i.why_zh, i.suggestion ?? ""]),
    result.summary.carry_forward_zh]);
  return result;
}

/** Quick check: `resolved`/`partial` must quote the checked snippet verbatim. */
export function validateWritingRecheck(raw: unknown, snippet: string, context: { baseFeedbackId: string; issueId: string }): WritingRecheck {
  const input = parse(recheckSpec, raw);
  const quote = input.evidence_quote?.trim() || null;
  const verbatim = Boolean(quote && containsQuote(snippet, quote));
  let result = input.result, adjusted = false;
  let why = input.why_zh;
  if ((result === "resolved" || result === "partial") && !verbatim) {
    result = "unresolved"; adjusted = true;
    why = "快检结论缺少可逐字核对的原文引用,因此不能判定为已解决。";
  }
  checkRules([why]);
  return { schema: WRITING_SCHEMA, mode: "recheck", baseFeedbackId: context.baseFeedbackId, issue: context.issueId,
    result, evidence_quote: verbatim ? quote : null, why_zh: why, adjusted };
}

/** Shape check for a frozen first review read back from the snapshot. */
export function isWritingCards(value: unknown): value is WritingCards {
  const v = value as WritingCards | null;
  return Boolean(v && v.schema === WRITING_SCHEMA && v.mode === "cards" && Array.isArray(v.issues));
}
export function isWritingFeedback(value: unknown): value is WritingFeedback {
  const v = value as WritingFeedback | null;
  return Boolean(v && v.schema === WRITING_SCHEMA && (v.mode === "cards" || v.mode === "delta" || v.mode === "recheck"));
}

const CATEGORY_ZH: Record<WritingCategory, string> = { TR: "任务回应", CC: "连贯", LR: "词汇", GRA: "语法" };
const PRIORITY_ZH: Record<WritingPriority, string> = { must: "必改", should: "建议", nice: "可选" };
const RESULT_ZH = { resolved: "已解决", partial: "部分解决", unresolved: "未解决", untouched: "未改动" } as const;

/** Plain-text rendering for legacy readers (MCP, history, backups). */
export function composeWritingText(writing: WritingFeedback): string {
  const issueLine = (issue: WritingIssue) =>
    `【${CATEGORY_ZH[issue.category]}·${PRIORITY_ZH[issue.priority]}】“${issue.quote}”：${issue.why_zh}` +
    (issue.suggestion ? ` 参考：${issue.suggestion}` : "");
  if (writing.mode === "recheck") return `单项快检【${RESULT_ZH[writing.result]}】${writing.issue}：${writing.why_zh}`;
  if (writing.mode === "cards") {
    return [
      ...writing.issues.map(issueLine),
      `下一步：${writing.summary.next_step_zh}`,
    ].join("\n").slice(0, 6000);
  }
  return [
    ...writing.verdicts.map(v => `【${RESULT_ZH[v.result]}】${v.issue}：${v.why_zh}`),
    ...writing.issues.map(issue => "新问题 " + issueLine(issue)),
    `下次带走：${writing.summary.carry_forward_zh}`,
  ].join("\n").slice(0, 6000);
}
