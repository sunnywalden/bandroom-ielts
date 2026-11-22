import { and, eq } from "drizzle-orm";
import type { ReviewAttempt } from "@/app/feedback-model";
import { getTenantDb } from "@/db";
import { reviewJobs } from "@/db/schema";
import type { reviewContext } from "./review-context";
import { createReviewTaskStatement, type ReviewTaskDb } from "./review-tasks";

export type FrozenReview = {
  sourceId: string;
  attempt: ReviewAttempt;
  context: ReturnType<typeof reviewContext>;
  recording?: { sha256: string; bytes: number };
};

export async function findSubmission(userId: string, submissionKey: string) {
  return getTenantDb(userId).select({
    id: reviewJobs.id, revision: reviewJobs.revision, requestHash: reviewJobs.requestHash, snapshot: reviewJobs.snapshot,
  }).from(reviewJobs).where(and(eq(reviewJobs.userId, userId), eq(reviewJobs.submissionKey, submissionKey))).get();
}

export async function frozenReviews(userId: string, day?: number) {
  return getTenantDb(userId).select({ id: reviewJobs.id, day: reviewJobs.day, revision: reviewJobs.revision, snapshot: reviewJobs.snapshot })
    .from(reviewJobs).where(day === undefined ? eq(reviewJobs.userId, userId)
      : and(eq(reviewJobs.userId, userId), eq(reviewJobs.day, day))).all();
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
