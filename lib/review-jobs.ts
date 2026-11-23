import { and, asc, eq } from "drizzle-orm";
import type { ReviewAttempt } from "@/app/feedback-model";
import { getTenantDb } from "@/db";
import { reviewJobs } from "@/db/schema";
import { isWritingCards, type WritingCards, type WritingIssue } from "./writing-feedback";
import type { reviewContext } from "./review-context";
import { createReviewTaskStatement, type ReviewTaskDb } from "./review-tasks";

export type FrozenReview = {
  sourceId: string;
  attempt: ReviewAttempt;
  context: ReturnType<typeof reviewContext> & WritingRevisionContext;
  recording?: { sha256: string; bytes: number };
};

/** Frozen into a second-draft (writeRevision) snapshot at submission time
 * (doc §4.8): the first draft text always; the first review's issue cards when
 * they exist (incremental review), or its prose when it is a legacy review. */
export type WritingRevisionContext = {
  firstDraft?: string;
  firstReview?: { feedbackId: string; issues: WritingIssue[] };
  firstFeedback?: string;
  /** Quick checks the learner ran against this first review (doc §4.5). */
  rechecksUsed?: number;
};

function parseAnalysis(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

export async function writingRevisionContext(userId: string, day: number, firstDraftSourceId: string,
  firstDraft: string): Promise<WritingRevisionContext> {
  // Raw tenant-scoped SQL (same client as submitReview) so the lookup runs
  // inside the tripwire and in every test harness.
  const db = getTenantDb(userId).$client as unknown as ReviewTaskDb;
  const jobs = await db.prepare("SELECT id, snapshot FROM review_jobs WHERE user_id=? AND day=?")
    .bind(userId, day).all<{ id: string; snapshot: string }>();
  const job = (jobs.results ?? []).find(row => {
    try { return (JSON.parse(row.snapshot) as { sourceId?: unknown })?.sourceId === firstDraftSourceId; }
    catch { return false; }
  });
  if (!job) return { firstDraft };
  const rows = await db.prepare(`SELECT id, feedback, analysis_json AS analysisJson FROM teacher_feedback
    WHERE user_id=? AND attempt=? ORDER BY created_at DESC, id DESC LIMIT 12`)
    .bind(userId, job.id).all<{ id: string; feedback: string; analysisJson: string | null }>();
  const list = rows.results ?? [];
  if (!list.length) return { firstDraft };
  // Select the newest CARD review, not merely the newest feedback row. A later
  // learner note (add_learner_note) is a newer row on this same attempt with no
  // cards; letting it win would silently hide the structured first review and
  // downgrade the second draft to a plain re-review.
  let cardRow: { id: string; feedback: string; analysisJson: string | null } | undefined;
  let cards: WritingCards | null = null;
  for (const row of list) {
    const analysis = parseAnalysis(row.analysisJson);
    if (isWritingCards(analysis)) { cardRow = row; cards = analysis; break; }
  }
  if (cardRow && cards) {
    const prefix = `recheck:${cardRow.id}:`;
    const used = await db.prepare("SELECT COUNT(*) AS n FROM review_jobs WHERE user_id=? AND substr(submission_key,1,?)=?")
      .bind(userId, prefix.length, prefix).first<{ n: number }>();
    return { firstDraft, firstReview: { feedbackId: cardRow.id, issues: cards.issues }, rechecksUsed: Number(used?.n ?? 0) };
  }
  return { firstDraft, firstFeedback: String(list[0].feedback).slice(0, 6000) };
}

export async function findSubmission(userId: string, submissionKey: string) {
  return getTenantDb(userId).select({
    id: reviewJobs.id, revision: reviewJobs.revision, requestHash: reviewJobs.requestHash, snapshot: reviewJobs.snapshot,
  }).from(reviewJobs).where(and(eq(reviewJobs.userId, userId), eq(reviewJobs.submissionKey, submissionKey))).get();
}

export async function frozenReviews(userId: string, day?: number) {
  // Deterministic oldest→newest order: callers take the LAST entry as the
  // latest quick check, and SQLite never promised an order without ORDER BY.
  return getTenantDb(userId).select({ id: reviewJobs.id, day: reviewJobs.day, revision: reviewJobs.revision, snapshot: reviewJobs.snapshot })
    .from(reviewJobs).where(day === undefined ? eq(reviewJobs.userId, userId)
      : and(eq(reviewJobs.userId, userId), eq(reviewJobs.day, day)))
    .orderBy(asc(reviewJobs.createdAt), asc(reviewJobs.id)).all();
}

export async function submitReview(
  userId: string, submissionKey: string, requestHash: string, revision: number,
  state: Record<string, unknown>, snapshot: FrozenReview,
  analysisVersion?: string,
) {
  const db = getTenantDb(userId).$client;
  const id = snapshot.attempt.id;
  const encoded = JSON.stringify(state);
  const now = Date.now();
  const task = createReviewTaskStatement(db as unknown as ReviewTaskDb, {
    taskId: crypto.randomUUID(),
    reviewJobId: id,
    userId,
    kind: snapshot.attempt.stage === "speak" && snapshot.attempt.recordingId ? "speaking" : "text",
    attemptId: id,
    day: snapshot.attempt.day,
    attemptRevision: revision + 1,
    recordingId: snapshot.attempt.recordingId ?? null,
    analysisVersion: snapshot.attempt.recordingId ? analysisVersion : undefined,
    now,
  });
  // The fresh ID authorizes exactly one checkpoint update. A stale or repeated
  // request cannot update progress, even if it races after the initial read.
  await db.batch([
    db.prepare(`INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM learner_states WHERE user_id=?),0)=?
      ON CONFLICT(user_id,submission_key) DO NOTHING`).bind(
        id, userId, snapshot.attempt.day, submissionKey, requestHash, revision + 1,
        JSON.stringify(snapshot), new Date().toISOString(), userId, revision,
      ),
    revision === 0
      ? db.prepare(`INSERT INTO learner_states(user_id,revision,state)
          SELECT ?,1,? WHERE EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND user_id=?)`).bind(userId, encoded, id, userId)
      : db.prepare(`UPDATE learner_states SET revision=?,state=? WHERE user_id=? AND revision=?
          AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND user_id=?)`).bind(revision + 1, encoded, userId, revision, id, userId),
    db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND user_id=?)
        OR EXISTS(SELECT 1 FROM learner_states WHERE user_id=? AND revision=? AND state=?)
        THEN 'true' ELSE 'rollback' END)`).bind(id, userId, userId, revision + 1, encoded),
    task,
  ] as unknown as Parameters<typeof db.batch>[0]);
  return findSubmission(userId, submissionKey);
}
