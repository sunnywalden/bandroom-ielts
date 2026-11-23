// "我改好了吗？" single-issue quick check (doc §4.5).
//
// A quick check is an ordinary text review task on a `writeRecheck` snapshot,
// so it inherits the existing receipts, tenant isolation, DSR export/delete,
// retention, quotas and the always-on runner. It never writes learner state.
// Limits: 5 per first-draft review, only for an issue whose anchor the
// learner actually changed (an untouched anchor has nothing to check).
import { getTenantDb } from "@/db";
import { reviewAttempts } from "@/app/feedback-model";
import { trackAnchor, type Span } from "@/app/writing-diff";
import { createReviewTaskStatement, type ReviewTaskDb } from "./review-tasks";
import { writingRevisionContext } from "./review-jobs";
import { RECHECK_FIELD, type WritingIssue } from "./writing-feedback";

export { RECHECK_FIELD };
export const RECHECK_LIMIT = 5;
const MAX_SNIPPET = 1200;

export class RecheckError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}

/** Expand a span to whole sentences so the checker sees the edit in context. */
export function sentenceAround(text: string, span: Span | null): string {
  if (!span) return text.slice(0, MAX_SNIPPET);
  const before = text.slice(0, span.start);
  const startMatch = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "), before.lastIndexOf("\n"));
  const start = startMatch < 0 ? 0 : startMatch + 1;
  const afterIndex = text.slice(span.end).search(/[.!?](\s|$)/);
  const end = afterIndex < 0 ? text.length : span.end + afterIndex + 1;
  return text.slice(start, end).trim().slice(0, MAX_SNIPPET);
}

async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export async function createRecheck(userId: string, input: { issueId: string; revised: string; why?: string },
  options: { beforeInsert?: () => Promise<void> } = {}) {
  const db = getTenantDb(userId).$client as unknown as ReviewTaskDb;
  const row = await db.prepare("SELECT revision, state FROM learner_states WHERE user_id=?")
    .bind(userId).first<{ revision: number; state: string }>();
  let state: { day?: number; finished?: boolean; entries?: Record<string, Record<string, string>> } | undefined;
  try { state = row ? JSON.parse(row.state) : undefined; } catch { state = undefined; }
  const day = Number(state?.day);
  const entry = state?.entries?.[day];
  if (!row || !Number.isSafeInteger(day) || state?.finished || !entry?.writeOriginal?.trim() || entry.writeRevision !== undefined)
    throw new RecheckError("not_revising");
  const original = entry.writeOriginal;
  const firstDraft = (await reviewAttempts(day, entry)).find(attempt => attempt.field === "writeOriginal");
  if (!firstDraft) throw new RecheckError("not_revising");
  const context = await writingRevisionContext(userId, day, firstDraft.id, original);
  const review = context.firstReview;
  if (!review) throw new RecheckError("no_cards");
  const issue = review.issues.find(item => item.id === input.issueId) as WritingIssue | undefined;
  if (!issue?.anchor) throw new RecheckError("issue_not_checkable");
  const tracked = trackAnchor(original, input.revised, issue.anchor);
  if (tracked.state === "untouched") throw new RecheckError("issue_untouched");

  const prefix = `recheck:${review.feedbackId}:`;
  const used = await db.prepare(`SELECT COUNT(*) AS n FROM review_jobs WHERE user_id=? AND substr(submission_key,1,?)=?`)
    .bind(userId, prefix.length, prefix).first<{ n: number }>();
  const n = Number(used?.n ?? 0);
  if (n >= RECHECK_LIMIT) throw new RecheckError("recheck_limit");
  // Quota is charged only for a check that will actually run.
  await options.beforeInsert?.();

  const jobId = "v2:" + crypto.randomUUID();
  const revisedSnippet = sentenceAround(input.revised, tracked.span);
  const snapshot = {
    sourceId: `${prefix}${issue.id}:${n + 1}`,
    attempt: {
      id: jobId, day, field: RECHECK_FIELD, index: n, stage: "write", title: "单项快检", kind: "subjective",
      response: revisedSnippet, conditions: "", evidence: "",
    },
    context: {
      baseFeedbackId: review.feedbackId,
      issue: { id: issue.id, category: issue.category, priority: issue.priority, quote: issue.quote, why_zh: issue.why_zh },
      originalSnippet: sentenceAround(original, issue.anchor),
      revisedSnippet,
      learnerWhy: (input.why ?? "").trim().slice(0, 160),
    },
  };
  const now = Date.now();
  const requestHash = await sha256(JSON.stringify([issue.id, revisedSnippet]));
  await db.batch([
    db.prepare(`INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,submission_key) DO NOTHING`)
      .bind(jobId, userId, day, `${prefix}${n + 1}`, requestHash, row.revision, JSON.stringify(snapshot), new Date(now).toISOString()),
    createReviewTaskStatement(db, {
      taskId: crypto.randomUUID(), reviewJobId: jobId, userId, kind: "text", attemptId: jobId, day,
      attemptRevision: row.revision, now,
    }),
  ] as never);
  const saved = await db.prepare(`SELECT id FROM review_jobs WHERE id=? AND user_id=?`).bind(jobId, userId).first<{ id: string }>();
  if (!saved) throw new RecheckError("recheck_busy", 503); // a concurrent request took slot n+1
  return { jobId, used: n + 1, limit: RECHECK_LIMIT, baseFeedbackId: review.feedbackId, issueId: issue.id };
}

/** True when a frozen review_jobs snapshot belongs to a quick check. */
export function isRecheckSnapshot(snapshot: unknown): boolean {
  const s = (typeof snapshot === "string" ? safeParse(snapshot) : snapshot) as { attempt?: { field?: unknown } } | null;
  return s?.attempt?.field === RECHECK_FIELD;
}
function safeParse(value: string) { try { return JSON.parse(value) as unknown; } catch { return null; } }

