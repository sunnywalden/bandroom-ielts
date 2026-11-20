// MT-3 (design rev3.1 §4.7 / F8): data-subject export (format 5) and
// resumable full-storage deletion.
//
// The export is a tenant-scoped JSON bundle: every learner table plus an R2
// object MANIFEST (key/size/etag). Audio bytes are deliberately not embedded;
// downloading recordings is a separate, signed operation. Token hashes, invite
// codes and backup keys are never selected here.
//
// Deletion runs in dependency order and persists a cursor after every step so
// a crashed/failed job can resume instead of restarting. A done job is a no-op.
// analysis_events rows are pseudonymised rather than removed (S9.1: keep the
// append-only audit trail, strip attribution/content). The tombstones reuse
// lib/admin.revokeUser so identity/PII handling stays in one place.
//
// D1 time-travel and R2 object versioning mean "deleted" is a logical state:
// provider-side snapshots may survive for their retention window. The manifest
// records that disclosure; it is not a claim of cryptographic erasure.
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/db/schema";
import { revokeUser } from "./admin";

export type DsrDb = DrizzleD1Database<typeof schema> & { $client: D1Database };
export type DsrRow = Record<string, unknown>;

export const DSR_EXPORT_FORMAT = "bandroom-dsr-export-v5";

const DELETION_DISCLOSURE =
  "D1 time-travel and R2 object versioning may retain provider-side copies for " +
  "their configured retention windows. Active rows and objects are removed; this " +
  "job is logically complete, not a guarantee of immediate physical erasure.";

export class DsrError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type DsrObject = { key: string; size: number; etag: string };

export type DsrExport = {
  format: typeof DSR_EXPORT_FORMAT;
  exportedAt: string;
  userId: string;
  tables: Record<string, DsrRow[]>;
  r2: {
    prefixes: string[];
    speaking: DsrObject[];
    reviewCheckpoints: DsrObject[];
  };
  disclosures: string[];
};

export type DsrDeleteManifest = {
  review_tasks_blocked: number;
  analysis_artifacts: number;
  review_receipts: number;
  review_tasks: number;
  review_jobs: number;
  teacher_feedback: number;
  teacher_lessons: number;
  learner_states: number;
  personal_calibration: number;
  calibration_candidates: number;
  calibration_events: number;
  automation_heartbeats: number;
  user_cost_ledger: number;
  consent_events: number;
  scheduler_heartbeats: number;
  user_tokens_revoked: number;
  tombstoned: boolean;
  pseudonymized: { analysis_events: number };
  r2: { speaking: number; reviewCheckpoints: number };
  finishedAt: string;
  disclosure: string;
};

export type DsrDeleteResult = {
  jobId: string;
  status: "done";
  manifest: DsrDeleteManifest;
};

const encodeUser = (userId: string) => encodeURIComponent(userId);
const speakingPrefix = (userId: string) => `speaking/${encodeUser(userId)}/`;
const checkpointPrefix = (userId: string) => `review-checkpoints/${encodeUser(userId)}/`;

async function rows(db: DsrDb, query: string, ...params: unknown[]): Promise<DsrRow[]> {
  const result = await db.$client.prepare(query).bind(...params).all();
  return (result.results ?? []) as DsrRow[];
}

async function runChange(db: DsrDb, query: string, ...params: unknown[]): Promise<number> {
  const result = await db.$client.prepare(query).bind(...params).run();
  return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
}

async function listObjects(bucket: R2Bucket, prefix: string): Promise<DsrObject[]> {
  const objects: DsrObject[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects ?? []) {
      objects.push({ key: object.key, size: object.size, etag: object.etag });
    }
    if (!page.truncated) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return objects;
}

/** Tenant-scoped DSR export (format 5). Returns the JSON bundle, not bytes. */
export async function exportDsr(db: DsrDb, bucket: R2Bucket, userId: string): Promise<DsrExport> {
  if (!userId) throw new DsrError(400, "invalid_user_id");

  const tables: Record<string, DsrRow[]> = {
    learner_states: await rows(db, "SELECT * FROM learner_states WHERE user_id=?", userId),
    teacher_lessons: await rows(db, "SELECT * FROM teacher_lessons WHERE user_id=? ORDER BY day", userId),
    teacher_feedback: await rows(db, "SELECT * FROM teacher_feedback WHERE user_id=? ORDER BY day,id", userId),
    review_jobs: await rows(db, "SELECT * FROM review_jobs WHERE user_id=? ORDER BY id", userId),
    review_tasks: await rows(db, "SELECT * FROM review_tasks WHERE user_id=? ORDER BY id", userId),
    review_receipts: await rows(db, "SELECT * FROM review_receipts WHERE user_id=? ORDER BY id", userId),
    analysis_artifacts: await rows(db,
      "SELECT * FROM analysis_artifacts WHERE task_id IN (SELECT id FROM review_tasks WHERE user_id=?) " +
      "ORDER BY task_id,stage,chunk_index,analyzer_version", userId),
    analysis_events: await rows(db, "SELECT * FROM analysis_events WHERE user_id=? ORDER BY id", userId),
    personal_calibration: await rows(db, "SELECT * FROM personal_calibration WHERE user_id=? ORDER BY expected,actual", userId),
    calibration_candidates: await rows(db,
      "SELECT * FROM calibration_candidates WHERE user_id=? ORDER BY shown_at,candidate_id", userId),
    calibration_events: await rows(db,
      "SELECT * FROM calibration_events WHERE user_id=? ORDER BY created_at,candidate_id", userId),
    automation_heartbeats: await rows(db,
      "SELECT * FROM automation_heartbeats WHERE user_id=? ORDER BY automation_id", userId),
    user_cost_ledger: await rows(db, "SELECT * FROM user_cost_ledger WHERE user_id=? ORDER BY utc_day", userId),
    consent_events: await rows(db, "SELECT * FROM consent_events WHERE user_id=? ORDER BY at,id", userId),
    // Legacy singleton heartbeat rows carry an owner; they are tenant data too.
    scheduler_heartbeats: await rows(db,
      "SELECT * FROM scheduler_heartbeats WHERE owner_user_id=? ORDER BY automation_id", userId),
    // Identity only. user_tokens/invites are intentionally absent: a DSR bundle
    // must never carry token hashes, invite codes or signing material.
    users: await rows(db,
      "SELECT user_id,idp_iss,idp_sub,email_normalized,display_name,role,status," +
      "consent_version,consent_at,revoked_at,created_at,updated_at FROM users WHERE user_id=?", userId),
  };

  const [speaking, reviewCheckpoints] = await Promise.all([
    listObjects(bucket, speakingPrefix(userId)),
    listObjects(bucket, checkpointPrefix(userId)),
  ]);

  return {
    format: DSR_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    userId,
    tables,
    r2: {
      prefixes: [speakingPrefix(userId), checkpointPrefix(userId)],
      speaking,
      reviewCheckpoints,
    },
    disclosures: [
      "Audio is represented by an object manifest (key, size, etag); recording bytes are not embedded.",
      DELETION_DISCLOSURE,
    ],
  };
}

type PrefixCursor = { done: boolean; count: number };

type DeleteCursor = {
  version: 1;
  startedAt: number;
  steps: Record<string, boolean>;
  counts: Record<string, number>;
  r2: { speaking: PrefixCursor; reviewCheckpoints: PrefixCursor };
};

function initialCursor(): DeleteCursor {
  return {
    version: 1,
    startedAt: Date.now(),
    steps: {},
    counts: {},
    r2: {
      speaking: { done: false, count: 0 },
      reviewCheckpoints: { done: false, count: 0 },
    },
  };
}

/** Merge a persisted cursor over the current shape so older jobs stay resumable. */
function normalizeCursor(raw: unknown): DeleteCursor {
  const base = initialCursor();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<DeleteCursor>;
  return {
    version: 1,
    startedAt: typeof value.startedAt === "number" ? value.startedAt : base.startedAt,
    steps: { ...base.steps, ...(value.steps && typeof value.steps === "object" ? value.steps : {}) },
    counts: { ...base.counts, ...(value.counts && typeof value.counts === "object" ? value.counts : {}) },
    r2: {
      speaking: { ...base.r2.speaking, ...(value.r2?.speaking ?? {}) },
      reviewCheckpoints: { ...base.r2.reviewCheckpoints, ...(value.r2?.reviewCheckpoints ?? {}) },
    },
  };
}

function buildManifest(cursor: DeleteCursor, finishedAt: number): DsrDeleteManifest {
  const count = (name: string) => Number(cursor.counts[name] ?? 0);
  return {
    review_tasks_blocked: count("blockReviewTasks"),
    analysis_artifacts: count("analysisArtifacts"),
    review_receipts: count("reviewReceipts"),
    review_tasks: count("reviewTasks"),
    review_jobs: count("reviewJobs"),
    teacher_feedback: count("teacherFeedback"),
    teacher_lessons: count("teacherLessons"),
    learner_states: count("learnerStates"),
    personal_calibration: count("personalCalibration"),
    calibration_candidates: count("calibrationCandidates"),
    calibration_events: count("calibrationEvents"),
    automation_heartbeats: count("automationHeartbeats"),
    user_cost_ledger: count("userCostLedger"),
    consent_events: count("consentEvents"),
    scheduler_heartbeats: count("schedulerHeartbeats"),
    user_tokens_revoked: count("tokensRevoked"),
    tombstoned: Boolean(cursor.counts.tombstoned),
    pseudonymized: { analysis_events: count("analysisEvents") },
    r2: {
      speaking: Number(cursor.r2.speaking.count ?? 0),
      reviewCheckpoints: Number(cursor.r2.reviewCheckpoints.count ?? 0),
    },
    finishedAt: new Date(finishedAt).toISOString(),
    disclosure: DELETION_DISCLOSURE,
  };
}

async function deletePrefix(
  bucket: R2Bucket,
  prefix: string,
  state: PrefixCursor,
  save: () => Promise<void>,
): Promise<void> {
  if (state.done) return;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    const keys = (page.objects ?? []).map(object => object.key);
    if (!keys.length) break;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      await bucket.delete(chunk);
      state.count += chunk.length;
      await save();
    }
    // Re-list from the start rather than trusting a pagination cursor that was
    // issued before the deletes; a partial crash then resumes cleanly.
  }
  state.done = true;
  await save();
}

/**
 * Resumable full-storage deletion for one tenant.
 *
 * Creates the dsr_jobs row when absent. A `done` row is a no-op; a `failed` or
 * interrupted row resumes from `cursor_json`. Errors mark the job failed while
 * preserving the cursor, then rethrow.
 */
export async function runDsrDelete(
  db: DsrDb,
  bucket: R2Bucket,
  userId: string,
  jobId: string,
  requestedBy: string,
): Promise<DsrDeleteResult> {
  if (!userId) throw new DsrError(400, "invalid_user_id");
  if (!jobId) throw new DsrError(400, "invalid_job_id");
  if (!requestedBy) throw new DsrError(400, "invalid_requester");

  const client = db.$client;
  const existing = (await client.prepare(
    "SELECT id,user_id,kind,status,cursor_json,manifest_json FROM dsr_jobs WHERE id=?",
  ).bind(jobId).all()).results?.[0] as
    | { id: string; user_id: string; kind: string; status: string; cursor_json: string | null; manifest_json: string | null }
    | undefined;

  if (existing && (existing.user_id !== userId || existing.kind !== "delete")) {
    throw new DsrError(409, "dsr_job_conflict");
  }
  if (existing?.status === "done") {
    let manifest: DsrDeleteManifest | Record<string, never> = {};
    if (existing.manifest_json) {
      try {
        manifest = JSON.parse(existing.manifest_json) as DsrDeleteManifest;
      } catch {
        manifest = {};
      }
    }
    return { jobId, status: "done", manifest: manifest as DsrDeleteManifest };
  }

  const now = Date.now();
  const cursor = normalizeCursor(existing?.cursor_json ? safeParse(existing.cursor_json) : null);

  if (existing) {
    await runChange(db,
      "UPDATE dsr_jobs SET status='running', cursor_json=?, updated_at=? WHERE id=?",
      JSON.stringify(cursor), now, jobId);
  } else {
    await runChange(db,
      "INSERT INTO dsr_jobs(id,user_id,kind,status,cursor_json,manifest_json,requested_by,created_at,updated_at,finished_at) " +
      "VALUES(?,?,'delete','running',?,NULL,?,?,?,NULL)",
      jobId, userId, JSON.stringify(cursor), requestedBy, now, now);
  }

  const save = async (): Promise<void> => {
    await runChange(db,
      "UPDATE dsr_jobs SET cursor_json=?, updated_at=? WHERE id=?",
      JSON.stringify(cursor), Date.now(), jobId);
  };

  const step = async (name: string, query: string, ...params: unknown[]) => {
    if (cursor.steps[name]) return;
    cursor.counts[name] = await runChange(db, query, ...params);
    cursor.steps[name] = true;
    await save();
  };

  try {
    // 1. Stop the queue before removing anything it points at. Bumping the
    //    epoch early invalidates any lease token a runner still holds; the
    //    final tombstone bumps it again via revokeUser.
    if (!cursor.steps.blockReviewTasks) {
      cursor.counts.blockReviewTasks = await runChange(db,
        "UPDATE review_tasks SET state='blocked', lease_until=NULL, updated_at=? " +
        "WHERE user_id=? AND state IN ('queued','running')", now, userId);
      await runChange(db,
        "UPDATE users SET revocation_epoch=revocation_epoch+1, updated_at=? WHERE user_id=?", now, userId);
      cursor.steps.blockReviewTasks = true;
      await save();
    }

    // 2-13. Dependency order. Every step is independently idempotent.
    await step("analysisArtifacts",
      "DELETE FROM analysis_artifacts WHERE task_id IN (SELECT id FROM review_tasks WHERE user_id=?)", userId);
    await step("reviewReceipts", "DELETE FROM review_receipts WHERE user_id=?", userId);
    await step("reviewTasks", "DELETE FROM review_tasks WHERE user_id=?", userId);
    await step("reviewJobs", "DELETE FROM review_jobs WHERE user_id=?", userId);
    await step("teacherFeedback", "DELETE FROM teacher_feedback WHERE user_id=?", userId);
    await step("teacherLessons", "DELETE FROM teacher_lessons WHERE user_id=?", userId);
    await step("learnerStates", "DELETE FROM learner_states WHERE user_id=?", userId);
    await step("personalCalibration", "DELETE FROM personal_calibration WHERE user_id=?", userId);
    await step("calibrationCandidates", "DELETE FROM calibration_candidates WHERE user_id=?", userId);
    await step("calibrationEvents", "DELETE FROM calibration_events WHERE user_id=?", userId);
    await step("automationHeartbeats", "DELETE FROM automation_heartbeats WHERE user_id=?", userId);
    await step("userCostLedger", "DELETE FROM user_cost_ledger WHERE user_id=?", userId);

    // 14. S9.1: keep the append-only audit rows, strip tenant attribution and
    //     content. task_id is cleared too so the row cannot be re-joined back.
    await step("analysisEvents",
      "UPDATE analysis_events SET user_id=NULL, task_id=NULL, metadata_json=NULL WHERE user_id=?", userId);

    // 15-16. Consent history and legacy scheduler heartbeats are removable.
    await step("consentEvents", "DELETE FROM consent_events WHERE user_id=?", userId);
    await step("schedulerHeartbeats", "DELETE FROM scheduler_heartbeats WHERE owner_user_id=?", userId);

    // 17. Tenant R2 prefixes only. analysis/<version>/ is GLOBAL shared model
    //     data and must never be touched by a tenant deletion.
    await deletePrefix(bucket, speakingPrefix(userId), cursor.r2.speaking, save);
    await deletePrefix(bucket, checkpointPrefix(userId), cursor.r2.reviewCheckpoints, save);

    // 18. Revoke bearer credentials. UPDATE (not delete) keeps the audit-able
    //     row while making every token unusable.
    await step("tokensRevoked",
      "UPDATE user_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", now, userId);

    // 19. Tombstone: revoked status, cleared direct PII, bumped epoch, PATs dead.
    if (!cursor.steps.tombstone) {
      const result = await revokeUser(db, requestedBy, userId, "dsr_delete");
      cursor.counts.tombstoned = result.revoked ? 1 : 0;
      cursor.steps.tombstone = true;
      await save();
    }

    const finishedAt = Date.now();
    const manifest = buildManifest(cursor, finishedAt);
    await runChange(db,
      "UPDATE dsr_jobs SET status='done', manifest_json=?, cursor_json=?, finished_at=?, updated_at=? WHERE id=?",
      JSON.stringify(manifest), JSON.stringify(cursor), finishedAt, finishedAt, jobId);
    return { jobId, status: "done", manifest };
  } catch (error) {
    // Preserve the cursor so a retry can continue from the last good step.
    try {
      await runChange(db,
        "UPDATE dsr_jobs SET status='failed', cursor_json=?, updated_at=? WHERE id=?",
        JSON.stringify(cursor), Date.now(), jobId);
    } catch {
      // Keep the original failure; a later retry can still repair the status.
    }
    throw error;
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Stream a DSR bundle as a JSON download (route helper). */
export function dsrDownloadResponse(value: unknown, userId: string): Response {
  const safe = userId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "export";
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="Bandroom-DSR-${safe}-${stamp}.json"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}