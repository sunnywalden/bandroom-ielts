// Pure state for the four-step writing loop (首稿 → 批改 → 二稿 → 复盘),
// docs/experience-upgrade-realtime-feedback-revision-2026-11-22.md §3.1.
// No JSX so it is unit-testable under node.
import type { WritingCards, WritingDelta, WritingFeedback, WritingIssue } from "@/lib/writing-feedback";
import { trackAnchors, type Span } from "./writing-diff";

export type LoopStep = "draft" | "review" | "revise" | "reflect";
export const STEP_LABELS: Record<LoopStep, string> = { draft: "首稿", review: "批改", revise: "二稿", reflect: "复盘" };
export const CATEGORY_ZH = { TR: "任务回应", CC: "连贯", LR: "词汇", GRA: "语法" } as const;
export const PRIORITY_ZH = { must: "必改", should: "建议", nice: "可选" } as const;
export const RESULT_ZH = { resolved: "已解决", partial: "部分解决", unresolved: "未解决", untouched: "未改动" } as const;
export const MIN_WHY = 4;

export function loopStep(input: { original?: string; revised?: string; revising: boolean }): LoopStep {
  if (input.original === undefined) return "draft";
  if (input.revised !== undefined) return "reflect";
  return input.revising ? "revise" : "review";
}

export function isCards(value: WritingFeedback | undefined): value is WritingCards {
  return value?.mode === "cards" && Array.isArray(value.issues);
}
export function isDelta(value: WritingFeedback | undefined): value is WritingDelta {
  return value?.mode === "delta" && Array.isArray(value.verdicts);
}

export function draftStats(text: string) {
  const words = (text.match(/\S+/g) ?? []).length;
  const paragraphs = text.split(/\n\s*\n|\n/).filter(part => part.trim()).length;
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter(part => part.trim()).length;
  return { words, paragraphs, avgSentence: sentences ? Math.round(words / sentences) : 0 };
}

export type Segment = { text: string; issue?: WritingIssue; n?: number };

/** Split the draft into plain and anchored segments (overlaps: first wins). */
export function segmentDraft(text: string, issues: WritingIssue[]): Segment[] {
  const anchored = issues
    .map((issue, index) => ({ issue, n: index + 1 }))
    .filter((row): row is { issue: WritingIssue & { anchor: Span }; n: number } => Boolean(row.issue.anchor))
    .sort((a, b) => a.issue.anchor.start - b.issue.anchor.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const { issue, n } of anchored) {
    const { start, end } = issue.anchor;
    if (start < cursor || end > text.length || start >= end) continue;
    if (start > cursor) out.push({ text: text.slice(cursor, start) });
    out.push({ text: text.slice(start, end), issue, n });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

export function parseList(raw: string | undefined): string[] {
  try {
    const value = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
export function parseWhy(raw: string | undefined): Record<string, string> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

/** Default selection: the review's priorities, else the first "must" issue. */
export function defaultSelection(cards: WritingCards): string[] {
  if (cards.summary.priorities.length) return cards.summary.priorities.slice(0, 2);
  const must = cards.issues.find(issue => issue.priority === "must");
  return must ? [must.id] : [];
}

export type IssueState = "changed" | "untouched" | "unanchored";

export function issueStates(original: string, revised: string, issues: WritingIssue[]): Record<string, IssueState> {
  const anchored = issues.filter(issue => issue.anchor);
  const tracked = trackAnchors(original, revised, anchored.map(issue => issue.anchor as Span));
  const out: Record<string, IssueState> = {};
  for (const issue of issues) out[issue.id] = "unanchored";
  anchored.forEach((issue, index) => { out[issue.id] = tracked[index].state; });
  return out;
}

export type RevisionGate = {
  ready: boolean;
  /** Why the submit button is disabled, in learner language ("" when ready). */
  reason: string;
  focus: string;
  issues: Array<{ id: string; state: IssueState; why: string }>;
};

/**
 * Client-side teaching gate for the second draft (doc §3.1 ③, §4.7).
 * The server keeps its structural rule (draft differs + writeFocus present);
 * this gate adds: at least one chosen anchor changed OR a note, and a short
 * "why" for every chosen must-fix issue that was changed.
 */
export function revisionGate(input: {
  original: string; revised: string; issues: WritingIssue[]; selected: string[];
  why: Record<string, string>; note: string;
}): RevisionGate {
  const chosen = input.issues.filter(issue => input.selected.includes(issue.id));
  const states = issueStates(input.original, input.revised, chosen);
  const rows = chosen.map(issue => ({ id: issue.id, state: states[issue.id], why: (input.why[issue.id] ?? "").trim() }));
  const numbered = new Map(input.issues.map((issue, index) => [issue.id, index + 1]));
  const parts = chosen
    .filter(issue => states[issue.id] === "changed" || (states[issue.id] === "unanchored" && (input.why[issue.id] ?? "").trim()))
    .map(issue => `#${numbered.get(issue.id)} ${CATEGORY_ZH[issue.category]}：${(input.why[issue.id] ?? "").trim() || "已修改"}`);
  const note = input.note.trim();
  const focus = [parts.length ? "改了：" + parts.join("；") : "", note].filter(Boolean).join(" · ").slice(0, 400);
  let reason = "";
  if (input.revised.trim() === input.original.trim()) reason = "二稿还和首稿一样。";
  else if (!parts.length && !note) reason = chosen.length
    ? "勾选的问题还没有改动；改动其中一处，或写一句补充说明。"
    : "写一句补充说明：这次改了什么。";
  else {
    const missing = chosen.find(issue => issue.priority === "must" && states[issue.id] === "changed"
      && (input.why[issue.id] ?? "").trim().length < MIN_WHY);
    if (missing) reason = `为必改项 #${numbered.get(missing.id)} 写一句“为什么这样改”。`;
  }
  return { ready: !reason, reason, focus, issues: rows };
}
