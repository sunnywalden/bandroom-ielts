import { getDb } from "@/db";

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;
const MAX_AGE_MS = 24 * 60 * 60_000;

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

type D1Like = {
  prepare(query: string): Prepared;
  batch(statements: Prepared[]): Promise<unknown[]>;
};

export type ReviewTaskDb = D1Like;

export type ReviewTask = {
  id: string;
  reviewJobId: string;
  userId: string;
  kind: "text" | "speaking";
  attemptId: string;
  day: number;
  attemptRevision: number;
  recordingId: string | null;
  stage: string;
  state: string;
  fence: number;
  attempts: number;
  claimKind: "auto" | "manual";
  manualGrantSha256: string | null;
  notificationEpoch: number;
  retryEpoch: number;
  claimedClientRunId: string | null;
  leaseUntil: number | null;
  nextAt: number;
  analysisVersion: string | null;
  checkpointSha256: string | null;
  coverage: number | null;
  lastError: string | null;
  receiptId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ReviewReceipt = {
  id: string;
  taskId: string;
  userId: string;
  attemptId: string;
  attemptRevision: number;
  recordingSha256: string | null;
  analysisVersion: string | null;
  fence: number;
  feedbackId: string;
  outputSha256: string;
  outputSha256V2: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
};

export class ReviewTaskError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ReviewTaskError";
    this.code = code;
  }
}

const taskColumns = `id, review_job_id AS reviewJobId, user_id AS userId, kind, attempt_id AS attemptId,
  day, attempt_revision AS attemptRevision, recording_id AS recordingId, stage, state, fence, attempts,
  claim_kind AS claimKind, manual_grant_sha256 AS manualGrantSha256,
  notification_epoch AS notificationEpoch, retry_epoch AS retryEpoch,
  claimed_client_run_id AS claimedClientRunId,
  lease_until AS leaseUntil, next_at AS nextAt, analysis_version AS analysisVersion,
  checkpoint_sha256 AS checkpointSha256, coverage, last_error AS lastError, receipt_id AS receiptId,
  created_at AS createdAt, updated_at AS updatedAt`;

function toTask(row: Record<string, unknown> | null): ReviewTask | null {
  if (!row) return null;
  return row as unknown as ReviewTask;
}

function toReceipt(row: Record<string, unknown> | null): ReviewReceipt | null {
  if (!row) return null;
  return {
    id: String(row.id), taskId: String(row.taskId), userId: String(row.userId),
    attemptId: String(row.attemptId), attemptRevision: Number(row.attemptRevision),
    recordingSha256: row.recordingSha256 == null ? null : String(row.recordingSha256),
    analysisVersion: row.analysisVersion == null ? null : String(row.analysisVersion),
    fence: Number(row.fence), feedbackId: String(row.feedbackId), outputSha256: String(row.outputSha256),
    outputSha256V2: row.outputSha256V2 == null ? null : String(row.outputSha256V2),
    payload: typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : (row.payloadJson as Record<string, unknown>),
    createdAt: Number(row.createdAt),
  };
}

export function reviewTaskDb(): D1Like {
  return getDb().$client as unknown as D1Like;
}

/** Statement for the same D1 batch that inserts the immutable review_jobs snapshot. */
export function createReviewTaskStatement(db: D1Like, input: {
  taskId: string;
  reviewJobId: string;
  userId: string;
  kind: "text" | "speaking";
  attemptId: string;
  day: number;
  attemptRevision: number;
  recordingId?: string | null;
  analysisVersion?: string | null;
  now: number;
}) {
  return db.prepare(`INSERT INTO review_tasks
    (id, review_job_id, user_id, kind, attempt_id, day, attempt_revision, recording_id,
     analysis_version, stage, state, fence, attempts, next_at, created_at, updated_at)
    SELECT ?,?,?,?,?,?,?,?,?, 'read_input','queued',0,0,?,?,?
    WHERE EXISTS (SELECT 1 FROM review_jobs WHERE id=? AND user_id=?)
    ON CONFLICT(review_job_id) DO NOTHING`)
    .bind(input.taskId, input.reviewJobId, input.userId, input.kind, input.attemptId, input.day,
      input.attemptRevision, input.recordingId ?? null, input.analysisVersion ?? null, input.now, input.now, input.now,
      input.reviewJobId, input.userId);
}

async function markExhausted(db: D1Like, userId: string, now: number) {
  await db.prepare(`UPDATE review_tasks
    SET state='needs_attention', last_error='processing_budget_exhausted', lease_until=NULL, updated_at=?
    WHERE user_id=? AND (
      (state IN ('queued','retry_wait') AND (attempts >= ? OR created_at <= ?))
      OR (state='running' AND lease_until <= ? AND (attempts >= ? OR created_at <= ?))
    )`)
    .bind(now, userId, MAX_ATTEMPTS, now - MAX_AGE_MS, now, MAX_ATTEMPTS, now - MAX_AGE_MS).run();
}

async function claimOne(db: D1Like, userId: string, now: number, clientRunId: string) {
  const row = await db.prepare(`UPDATE review_tasks
    SET state='running', fence=fence+1, attempts=attempts+1, lease_until=?, updated_at=?,
        claimed_by=?, claim_kind='auto', manual_grant_sha256=NULL, claimed_client_run_id=?
    WHERE id = (
      SELECT id FROM review_tasks
      WHERE user_id=?
        AND ((state IN ('queued','retry_wait') AND next_at<=?)
          OR (state='running' AND lease_until<=?))
        AND attempts < ? AND created_at > ?
      ORDER BY next_at, id LIMIT 1
    )
    RETURNING ${taskColumns}`)
    .bind(now + LEASE_MS, now, clientRunId, clientRunId, userId, now, now, MAX_ATTEMPTS, now - MAX_AGE_MS)
    .first<Record<string, unknown>>();
  return toTask(row);
}

export async function claimReviewTasks(db: D1Like, userId: string, options: {
  limit?: number; now?: number; clientRunId?: string;
} = {}) {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(3, options.limit ?? 1));
  const clientRunId = options.clientRunId ?? "unknown";
  await markExhausted(db, userId, now);
  const tasks: ReviewTask[] = [];
  for (let index = 0; index < limit; index += 1) {
    const task = await claimOne(db, userId, now, clientRunId);
    if (!task) break;
    tasks.push(task);
  }
  return tasks;
}

// Claim the next due task ACROSS tenants (runner-only queue path, rev2 §7).
// The target tenant is derived server-side from the task row (RETURNING includes
// user_id); the caller's identity never selects it, preserving the "no
// client-supplied userId" invariant. Fence + lease_until + task.userId are the
// bound lease that every downstream queue call must present.
//
// rev3.1 F5 fix: markExhaustedGlobal ensures tasks that hit MAX_ATTEMPTS or
// MAX_AGE are moved to needs_attention (visible in UI + alertable). Previously
// only the per-user claimReviewTasks called markExhausted; the cross-tenant
// path never did, so exhausted tasks stranded in retry_wait forever.
export async function claimNextReviewTask(db: D1Like, options: { now?: number; clientRunId?: string } = {}) {
  const now = options.now ?? Date.now();
  const clientRunId = options.clientRunId ?? "unknown";
  await markExhaustedGlobal(db, now);
  const row = await db.prepare(`UPDATE review_tasks
    SET state='running', fence=fence+1, attempts=attempts+1, lease_until=?, updated_at=?,
        claimed_by=?, claim_kind='auto', manual_grant_sha256=NULL, claimed_client_run_id=?
    WHERE id = (
      SELECT id FROM review_tasks
      WHERE ((state IN ('queued','retry_wait') AND next_at<=?)
          OR (state='running' AND lease_until<=?))
        AND attempts < ? AND created_at > ?
      ORDER BY next_at, id LIMIT 1
    )
    RETURNING ${taskColumns}`)
    .bind(now + LEASE_MS, now, clientRunId, clientRunId, now, now, MAX_ATTEMPTS, now - MAX_AGE_MS)
    .first<Record<string, unknown>>();
  return toTask(row);
}

// F5: global exhaustion sweep for the cross-tenant claim path. Unlike
// markExhausted (per-user), this does not filter by user_id because the
// cross-tenant claim selects across all tenants.
async function markExhaustedGlobal(db: D1Like, now: number) {
  await db.prepare(`UPDATE review_tasks
    SET state='needs_attention', last_error='processing_budget_exhausted', lease_until=NULL, updated_at=?
    WHERE (
      (state IN ('queued','retry_wait') AND (attempts >= ? OR created_at <= ?))
      OR (state='running' AND lease_until <= ? AND (attempts >= ? OR created_at <= ?))
    )`)
    .bind(now, MAX_ATTEMPTS, now - MAX_AGE_MS, now, MAX_ATTEMPTS, now - MAX_AGE_MS).run();
}

// F5: check whether any OTHER tenant has a due task. The runner uses this to
// decide whether yielding is meaningful (fairness) or harmful (stranding the
// only active tenant's backlog). Returns true if at least one other user has
// a claimable task right now.
export async function hasOtherDueTasks(db: D1Like, excludeUserId: string, options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  const row = await db.prepare(`SELECT 1 AS ok FROM review_tasks
    WHERE user_id<>?
      AND ((state IN ('queued','retry_wait') AND next_at<=?)
        OR (state='running' AND lease_until<=?))
      AND attempts < ? AND created_at > ?
    LIMIT 1`)
    .bind(excludeUserId, now, now, MAX_ATTEMPTS, now - MAX_AGE_MS)
    .first<{ ok: number }>();
  return Boolean(row);
}

export async function renewReviewLease(db: D1Like, userId: string, taskId: string, fence: number, options: {
  now?: number; extendMs?: number;
} = {}) {
  const now = options.now ?? Date.now();
  const extendMs = Math.max(30_000, options.extendMs ?? LEASE_MS);
  const row = await db.prepare(`UPDATE review_tasks SET lease_until=MAX(lease_until, ?), updated_at=?
    WHERE id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?
    RETURNING lease_until AS leaseUntil`)
    .bind(now + extendMs, now, taskId, userId, fence, now).first<{ leaseUntil: number }>();
  if (!row) throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
  return { leaseUntil: Number(row.leaseUntil), serverNow: now };
}

export async function saveReviewCheckpoint(db: D1Like, userId: string, input: {
  taskId: string; fence: number; analysisVersion: string; stage: string; chunkIndex: number;
  inputSha256: string; artifactSha256: string; bytes: number; coverage?: number;
  objectRef?: string | null; payload?: Record<string, unknown>; now?: number;
  expectedDecodePointer?: string | null;
  expectedAcousticPointer?: { stage: "decode" | "acoustic"; sha256: string };
}) {
  const now = input.now ?? Date.now();
  const lease = [input.taskId, userId, input.fence, now];
  const key = [input.taskId, input.stage, input.chunkIndex, input.analysisVersion];
  const objectRef = input.objectRef ?? null;
  const payloadJson = JSON.stringify(input.payload ?? {});
  const active = "id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?";
  const artifact = "task_id=? AND stage=? AND chunk_index=? AND analyzer_version=?";
  const verifiedDecode = input.expectedDecodePointer !== undefined;
  const previous = input.expectedAcousticPointer;
  const pointer = `AND (?=0 OR (stage IN ('read_input','decode') AND checkpoint_sha256 IS ?))
    AND (? IS NULL OR (stage=? AND checkpoint_sha256=?))`;
  const pointerArgs = [Number(verifiedDecode), input.expectedDecodePointer ?? null,
    previous?.stage ?? null, previous?.stage ?? null, previous?.sha256 ?? null];
  const [insert, , readback] = await db.batch([
    db.prepare(`INSERT INTO analysis_artifacts
      (task_id, stage, chunk_index, analyzer_version, input_sha256, artifact_sha256, bytes, object_ref, payload_json, created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM review_tasks WHERE ${active} AND (analysis_version IS NULL OR analysis_version=?) ${pointer}
      )
      ON CONFLICT(task_id, stage, chunk_index, analyzer_version) DO UPDATE SET
        artifact_sha256=excluded.artifact_sha256, bytes=excluded.bytes, object_ref=excluded.object_ref,
        payload_json=excluded.payload_json, created_at=excluded.created_at
      WHERE ?=1 AND analysis_artifacts.stage='decode' AND analysis_artifacts.chunk_index=0
        AND analysis_artifacts.input_sha256=excluded.input_sha256
        AND COALESCE(json_extract(analysis_artifacts.payload_json, '$.format'), '')<>'bandroom-decode-v1'`)
      .bind(...key, input.inputSha256, input.artifactSha256, input.bytes,
        objectRef, payloadJson, now, ...lease, input.analysisVersion, ...pointerArgs, Number(verifiedDecode)),
    // A matching replay can repair an old artifact whose task pointer was never written.
    db.prepare(`UPDATE review_tasks
      SET stage=?, checkpoint_sha256=?, coverage=COALESCE(?, coverage),
          analysis_version=COALESCE(analysis_version, ?), lease_until=MAX(lease_until, ?), updated_at=?
      WHERE ${active} AND (analysis_version IS NULL OR analysis_version=?) ${pointer}
        AND (changes()=1 OR (checkpoint_sha256 IS NULL AND EXISTS (
          SELECT 1 FROM analysis_artifacts WHERE ${artifact} AND input_sha256=? AND artifact_sha256=? AND bytes=?
            AND object_ref IS ? AND payload_json=?
        )))`)
      .bind(input.stage, input.artifactSha256, input.coverage ?? null, input.analysisVersion,
        now + LEASE_MS, now, ...lease, input.analysisVersion, ...pointerArgs, ...key,
        input.inputSha256, input.artifactSha256, input.bytes, objectRef, payloadJson),
    db.prepare(`SELECT analysis_version AS analysisVersion, checkpoint_sha256 AS checkpointSha256, review_tasks.stage,
        a.input_sha256 AS inputSha256, a.artifact_sha256 AS artifactSha256, a.bytes,
        a.object_ref AS objectRef, a.payload_json AS payloadJson
      FROM review_tasks LEFT JOIN analysis_artifacts a
        ON a.task_id=review_tasks.id AND a.stage=? AND a.chunk_index=? AND a.analyzer_version=?
      WHERE review_tasks.id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?`)
      .bind(input.stage, input.chunkIndex, input.analysisVersion, ...lease),
  ]) as [
    { meta?: { changes?: number } },
    unknown,
    { results?: Array<{
      analysisVersion: string | null; checkpointSha256: string | null; stage: string;
      inputSha256: string | null; artifactSha256: string | null; bytes: number | null;
      objectRef: string | null; payloadJson: string | null;
    }> },
  ];
  const current = readback.results?.[0];
  if (!current) throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
  if (current.analysisVersion !== null && current.analysisVersion !== input.analysisVersion)
    throw new ReviewTaskError("analysis_version_mismatch", "Checkpoints cannot mix analyzer versions.");
  if (current.artifactSha256 === null && (
    (verifiedDecode && current.checkpointSha256 !== input.expectedDecodePointer)
    || (previous && (current.stage !== previous.stage || current.checkpointSha256 !== previous.sha256))
  ))
    throw new ReviewTaskError("checkpoint_advanced", "The checkpoint changed before this write committed.");
  if (current.inputSha256 !== input.inputSha256 || current.artifactSha256 !== input.artifactSha256 ||
      current.bytes !== input.bytes || current.objectRef !== objectRef || current.payloadJson !== payloadJson)
    throw new ReviewTaskError("artifact_conflict", "A different artifact already exists for this chunk.");
  return { saved: true, duplicate: insert.meta?.changes !== 1, checkpointSha256: current.checkpointSha256 };
}

export async function readReviewCheckpoint(db: D1Like, userId: string, input: {
  taskId: string; fence: number; stage?: string; chunkIndex?: number; now?: number;
}) {
  const now = input.now ?? Date.now();
  const current = input.stage === undefined;
  const row = await db.prepare(`SELECT a.stage, a.chunk_index AS chunkIndex, a.analyzer_version AS analysisVersion,
        a.input_sha256 AS inputSha256, a.artifact_sha256 AS artifactSha256, a.bytes,
        a.object_ref AS objectRef, a.payload_json AS payloadJson
      FROM review_tasks t LEFT JOIN analysis_artifacts a
        ON a.task_id=t.id AND t.analysis_version=a.analyzer_version
        AND ${current ? "a.stage=t.stage AND a.artifact_sha256=t.checkpoint_sha256" : "a.stage=? AND a.chunk_index=?"}
      WHERE t.id=? AND t.user_id=? AND t.fence=? AND t.state='running' AND t.lease_until>?
      ORDER BY a.created_at DESC, a.chunk_index DESC LIMIT 1`)
    .bind(...(current ? [] : [input.stage, input.chunkIndex]), input.taskId, userId, input.fence, now)
    .first<{
      stage: string; chunkIndex: number; analysisVersion: string; inputSha256: string;
      artifactSha256: string; bytes: number; objectRef: string | null; payloadJson: string | null;
    }>();
  if (!row) throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
  if (row.payloadJson === null) return null;
  const { payloadJson, ...checkpoint } = row;
  return { ...checkpoint, payload: JSON.parse(payloadJson) as Record<string, unknown> };
}

export async function failReviewTask(db: D1Like, userId: string, input: {
  taskId: string; fence: number; code: string; retryable: boolean; nextAt?: number; now?: number;
}) {
  const now = input.now ?? Date.now();
  const state = input.retryable ? "retry_wait" : "blocked";
  const nextAt = input.retryable ? (input.nextAt ?? now + 5 * 60_000) : now;
  const row = await db.prepare(`UPDATE review_tasks
    SET state=?, last_error=?, next_at=?, retry_epoch=retry_epoch+?, lease_until=NULL, updated_at=?
    WHERE id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?
    RETURNING ${taskColumns}`)
    .bind(state, input.code, nextAt, input.retryable ? 1 : 0, now, input.taskId, userId, input.fence, now)
    .first<Record<string, unknown>>();
  const task = toTask(row);
  if (!task) throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
  return task;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export async function sha256Json(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function completeReviewTask(db: D1Like, userId: string, input: {
  taskId: string; fence: number; output: Record<string, unknown>;
  manualGrantSha256?: string;
  feedback: {
    id: string; day: number; stage: string; attempt: string; evidence: string; feedback: string;
    pronunciation?: unknown; analysis?: Record<string, unknown>;
  };
  receipt: {
    recordingSha256?: string | null; analysisVersion?: string | null; payload?: Record<string, unknown>;
  };
  now?: number;
}) {
  const outputSha256V2 = await sha256Json({
    ...input.output,
    pronunciation: input.feedback.pronunciation ?? null,
  });
  let outputSha256: string | null = null;
  const v1Digest = async () => outputSha256 ?? (outputSha256 = await sha256Json(input.output));
  let cachedReceipt: ReviewReceipt | null | undefined;
  const matchingReceipt = async (fresh = false) => {
    if (fresh) cachedReceipt = undefined;
    const receipt = cachedReceipt !== undefined ? cachedReceipt : (cachedReceipt = await readReviewReceipt(db, userId, input.taskId));
    if (receipt) {
      // Legacy receipts used the v1 digest; new receipts bind pronunciation too.
      if (receipt.outputSha256V2) {
        if (receipt.outputSha256V2 !== outputSha256V2)
          throw new ReviewTaskError("receipt_conflict", "A different result was already committed for this task.");
      } else {
        if (receipt.outputSha256 !== await v1Digest())
          throw new ReviewTaskError("receipt_conflict", "A different result was already committed for this task.");
        // v1 did not hash pronunciation. Compare against the stored row so a
        // replay cannot silently replace a rating on a pre-upgrade receipt.
        if (input.feedback.pronunciation !== undefined) {
          const row = await db.prepare(`SELECT pronunciation FROM teacher_feedback
            WHERE id=? AND user_id=?`).bind(receipt.feedbackId, userId)
            .first<{ pronunciation: string | null }>();
          const stored = row?.pronunciation ? JSON.parse(row.pronunciation) as unknown : null;
          if (await sha256Json(stored) !== await sha256Json(input.feedback.pronunciation))
            throw new ReviewTaskError("receipt_conflict", "The stored pronunciation differs from this result.");
        }
      }
    }
    return receipt;
  };
  const existing = await matchingReceipt();
  if (existing) return { receipt: existing, duplicate: true };

  const task = toTask(await db.prepare(`SELECT ${taskColumns} FROM review_tasks
    WHERE id=? AND user_id=?`).bind(input.taskId, userId).first<Record<string, unknown>>());
  if (!task) throw new ReviewTaskError("task_not_found", "The task is not available to this account.");
  if (task.state === "completed") {
    const receipt = await matchingReceipt();
    if (receipt) return { receipt, duplicate: true };
  }
  const now = input.now ?? Date.now();
  if (task.state !== "running" || task.fence !== input.fence || (task.leaseUntil ?? 0) <= now)
    throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
  if (task.claimKind === "manual" && task.manualGrantSha256 &&
      input.manualGrantSha256 !== task.manualGrantSha256)
    throw new ReviewTaskError("manual_grant_invalid", "The manual review grant does not match the current claim.");
  if (input.feedback.attempt !== task.attemptId) throw new ReviewTaskError("attempt_mismatch", "Feedback must bind to the task's exact attempt.");
  if (input.feedback.day !== task.day) throw new ReviewTaskError("attempt_mismatch", "Feedback day differs from the task.");

  const receiptId = crypto.randomUUID();
  const statements = [
    db.prepare(`INSERT INTO teacher_feedback
      (id, user_id, day, stage, attempt, evidence, feedback, pronunciation, review_task_id, analysis_json, created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM review_tasks WHERE id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?)
      ON CONFLICT(review_task_id) DO NOTHING`)
      .bind(input.feedback.id, userId, input.feedback.day, input.feedback.stage, input.feedback.attempt,
        input.feedback.evidence, input.feedback.feedback,
        input.feedback.pronunciation == null ? null : JSON.stringify(input.feedback.pronunciation),
        input.taskId, input.feedback.analysis == null ? null : JSON.stringify(input.feedback.analysis),
        new Date(now).toISOString(), input.taskId, userId, input.fence, now),
    db.prepare(`INSERT INTO review_receipts
      (id, task_id, user_id, attempt_id, attempt_revision, recording_sha256, analysis_version, fence,
       feedback_id, output_sha256, output_sha256_v2, payload_json, created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM review_tasks WHERE id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?)
      ON CONFLICT(task_id) DO NOTHING`)
      .bind(receiptId, input.taskId, userId, task.attemptId, task.attemptRevision,
        input.receipt.recordingSha256 ?? null, input.receipt.analysisVersion ?? task.analysisVersion ?? null,
        input.fence, input.feedback.id, await v1Digest(), outputSha256V2,
        JSON.stringify(input.receipt.payload ?? {}), now,
        input.taskId, userId, input.fence, now),
    db.prepare(`UPDATE review_tasks
      SET state='completed', receipt_id=?, last_error=NULL, lease_until=NULL, updated_at=?
      WHERE id=? AND user_id=? AND fence=? AND state='running' AND lease_until>?`)
      .bind(receiptId, now, input.taskId, userId, input.fence, now),
  ];
  const results = await db.batch(statements) as Array<{ meta?: { changes?: number } }>;
  const changed = results?.[2]?.meta?.changes;
  const receipt = await matchingReceipt(true);
  if (!receipt && changed !== 1) throw new ReviewTaskError("stale_lease", "The task lease expired before completion.");
  if (!receipt) throw new ReviewTaskError("receipt_missing", "The completion receipt was not persisted.");
  return { receipt, duplicate: receipt.id !== receiptId };
}

export async function findReviewTaskByAttempt(db: D1Like, userId: string, attemptId: string) {
  return toTask(await db.prepare(`SELECT ${taskColumns} FROM review_tasks
    WHERE user_id=? AND attempt_id=?`).bind(userId, attemptId).first<Record<string, unknown>>());
}

/**
 * Claim a task for a human/coach completion. Manual takeover invalidates any
 * live automatic lease by increasing the fence; old auto writes then fail.
 * A completed task is not claimable, so the caller must read its receipt.
 */
export async function claimManualReviewTask(db: D1Like, userId: string, taskId: string, options: {
  now?: number; nonce?: string;
} = {}) {
  const now = options.now ?? Date.now();
  const existing = await getReviewTask(db, userId, taskId);
  if (!existing || existing.state === "completed") return null;
  // Concurrent manual requests share one live manual claim. Only an expired
  // manual lease, a pending task, or a live automatic claim is taken over.
  if (existing.state === "running" && existing.claimKind === "manual" && (existing.leaseUntil ?? 0) > now)
    return existing;
  const nonce = options.nonce ?? crypto.randomUUID();
  const grantSha256 = await sha256Json({ userId, taskId, now, nonce });
  const row = await db.prepare(`UPDATE review_tasks
    SET state='running', fence=fence+1, claim_kind='manual', manual_grant_sha256=?,
        notification_epoch=notification_epoch+1, claimed_client_run_id=?,
        lease_until=?, next_at=?, updated_at=?
    WHERE id=? AND user_id=?
      AND (state IN ('queued','retry_wait','blocked','needs_attention')
        OR (state='running' AND (claim_kind<>'manual' OR lease_until<=?)))
    RETURNING ${taskColumns}`)
    .bind(grantSha256, `manual:${nonce}`, now + LEASE_MS, now, now, taskId, userId, now)
    .first<Record<string, unknown>>();
  if (row) return toTask(row);
  const current = await getReviewTask(db, userId, taskId);
  return current?.state === "running" && current.claimKind === "manual" ? current : null;
}

export async function getReviewTask(db: D1Like, userId: string, taskId: string) {
  return toTask(await db.prepare(`SELECT ${taskColumns} FROM review_tasks WHERE id=? AND user_id=?`)
    .bind(taskId, userId).first<Record<string, unknown>>());
}

export async function readReviewReceipt(db: D1Like, userId: string, taskId: string) {
  return toReceipt(await db.prepare(`SELECT id, task_id AS taskId, user_id AS userId,
      attempt_id AS attemptId, attempt_revision AS attemptRevision, recording_sha256 AS recordingSha256,
      analysis_version AS analysisVersion, fence, feedback_id AS feedbackId, output_sha256 AS outputSha256,
      output_sha256_v2 AS outputSha256V2, payload_json AS payloadJson, created_at AS createdAt
    FROM review_receipts WHERE task_id=? AND user_id=?`)
    .bind(taskId, userId).first<Record<string, unknown>>());
}

export async function listReviewTasks(db: D1Like, userId: string, limit = 50) {
  const rows = await db.prepare(`SELECT ${taskColumns} FROM review_tasks
    WHERE user_id=? ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .bind(userId, Math.max(1, Math.min(100, limit))).all<Record<string, unknown>>();
  return (rows.results ?? []).map(row => toTask(row)!).filter(Boolean);
}

export async function recordAnalysisEvent(db: D1Like, input: {
  at?: number; taskId?: string | null; fence?: number | null; event: string; stage?: string | null;
  outcome: string; clientRunId?: string | null; requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  await db.prepare(`INSERT INTO analysis_events
    (at, task_id, fence, event, stage, outcome, client_run_id, request_id, metadata_json, user_id)
    VALUES (?,?,?,?,?,?,COALESCE(?,(
      SELECT client_run_id FROM analysis_events WHERE task_id=? AND fence=? AND event='claim_review_tasks'
      ORDER BY id DESC LIMIT 1
    )),?,?,(SELECT user_id FROM review_tasks WHERE id=?))`)
    .bind(input.at ?? Date.now(), input.taskId ?? null, input.fence ?? null, input.event,
      input.stage ?? null, input.outcome, input.clientRunId ?? null,
      input.taskId ?? null, input.fence ?? null, input.requestId ?? null,
      input.metadata == null ? null : JSON.stringify(input.metadata),
      input.taskId ?? null).run();
}

export async function reportSchedulerHeartbeat(db: D1Like, input: {
  automationId: string; generation: number; clientRunId: string; status: string;
  ownerUserId: string;
  startedAt?: number; finishedAt?: number; nextExpectedAt?: number; detail?: string | null; now?: number;
}) {
  const now = input.now ?? Date.now();
  const result = await db.prepare(`INSERT INTO automation_heartbeats
    (user_id, automation_id, generation, client_run_id, started_at, finished_at, last_success_at, next_expected_at, status, detail)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, automation_id) DO UPDATE SET
      generation=excluded.generation, client_run_id=excluded.client_run_id,
      started_at=COALESCE(excluded.started_at, automation_heartbeats.started_at),
      finished_at=COALESCE(excluded.finished_at, automation_heartbeats.finished_at),
      last_success_at=CASE WHEN excluded.status='finished' THEN ? ELSE automation_heartbeats.last_success_at END,
      next_expected_at=COALESCE(excluded.next_expected_at, automation_heartbeats.next_expected_at),
      status=excluded.status, detail=excluded.detail
    WHERE (excluded.started_at IS NOT NULL AND excluded.started_at >= COALESCE(automation_heartbeats.started_at,0))
       OR (excluded.started_at IS NULL AND excluded.generation >= automation_heartbeats.generation)`)
    .bind(input.ownerUserId, input.automationId, input.generation, input.clientRunId,
      input.startedAt ?? null, input.finishedAt ?? null, input.status === "finished" ? now : null,
      input.nextExpectedAt ?? null, input.status, input.detail ?? null, now).run();
  return { updated: (result.meta?.changes ?? 0) > 0 };
}
