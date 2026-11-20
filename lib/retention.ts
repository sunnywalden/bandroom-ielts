// MT-3 retention policy + purge logic (design rev3.1 §4.7).
//
// Account-lifetime learner data (learner_states, teacher_feedback,
// teacher_lessons, personal calibration) is NOT touched here: it is removed
// only by a DSR delete. This module owns the time-boxed classes:
//   * speaking_audio        R2 speaking/<uid>/<id>              (90 days)
//   * review_checkpoints    R2 review-checkpoints/<uid>/...     (7 days)
//   * runner_cache          runner-local acoustic cache          (7 days)
//   * runner_logs           runner-local log files              (30 days)
//   * backup_archives       backup archives                     (30 days)
//   * audit_events          analysis_events attribution         (365 days)
//
// `analysis/<version>/` is GLOBAL shared model data and is never listed or
// deleted by this module. runRetention is invoked from the Worker scheduled
// handler with the raw D1 binding and R2 bucket (see worker/index.ts).

export type RetentionAction = "delete" | "anonymize";

export interface RetentionRule {
  days: number;
  action: RetentionAction;
}

/** Seed defaults per design rev3.1 §4.7. `audit_events` anonymizes attribution
 *  in place; every other class is deleted at its boundary. */
export const DEFAULT_RETENTION = {
  speaking_audio: { days: 90, action: "delete" },
  review_checkpoints: { days: 7, action: "delete" },
  runner_cache: { days: 7, action: "delete" },
  runner_logs: { days: 30, action: "delete" },
  backup_archives: { days: 30, action: "delete" },
  audit_events: { days: 365, action: "anonymize" },
} as const satisfies Record<string, RetentionRule>;

export type RetentionPolicy = Map<string, RetentionRule>;

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_PAGE_LIMIT = 1000;
const DELETE_BATCH_SIZE = 500;

/** Prefixes this module is allowed to purge. `analysis/` is intentionally
 *  absent so shared model data can never be reached. */
const R2_PURGE_PREFIXES = {
  speakingDeleted: "speaking/",
  checkpointsDeleted: "review-checkpoints/",
} as const;

export interface RetentionR2Result {
  speakingDeleted: number;
  checkpointsDeleted: number;
}

export interface RetentionManifest {
  r2: RetentionR2Result;
  auditAnonymized: number;
  ranAt: number;
}

interface D1ResultLike {
  meta?: { changes?: number };
}

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<D1ResultLike>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

/** Minimal D1 surface used here. The scheduled handler passes `env.DB`; tests
 *  pass the same prepare/bind/run shape used by the other lib modules. */
export interface RetentionDb {
  prepare(query: string): D1StatementLike;
}

interface R2ObjectLike {
  key: string;
  uploaded: Date | string;
}

interface R2ListingLike {
  objects: R2ObjectLike[];
  truncated: boolean;
  cursor?: string;
}

/** Minimal R2 surface: only prefix listing and (batch) delete are used. */
export interface RetentionBucket {
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListingLike>;
  delete(keys: string | string[]): Promise<void>;
}

function ruleFor(policy: RetentionPolicy, dataClass: string): RetentionRule {
  const configured = policy.get(dataClass);
  if (configured && Number.isFinite(configured.days) && configured.days >= 0) return configured;
  const fallback = DEFAULT_RETENTION[dataClass as keyof typeof DEFAULT_RETENTION];
  if (fallback) return fallback;
  throw new Error(`retention policy is missing data class \`${dataClass}\``);
}

function cutoffFor(now: number, rule: RetentionRule): number {
  return now - rule.days * DAY_MS;
}

/** Insert the design defaults. Idempotent: existing operator overrides win. */
export async function seedRetentionPolicy(db: RetentionDb, now = Date.now()): Promise<void> {
  const insert = "INSERT OR IGNORE INTO retention_policy " +
    "(data_class, retention_days, action, updated_at) VALUES (?, ?, ?, ?)";
  for (const [dataClass, rule] of Object.entries(DEFAULT_RETENTION)) {
    await db.prepare(insert).bind(dataClass, rule.days, rule.action, now).run();
  }
}

/** Read every configured class. Missing classes fall back to DEFAULT_RETENTION. */
export async function getRetentionPolicy(db: RetentionDb): Promise<RetentionPolicy> {
  const { results } = await db.prepare(
    "SELECT data_class, retention_days, action FROM retention_policy",
  ).all<{ data_class: string; retention_days: number; action: string }>();
  const policy: RetentionPolicy = new Map();
  for (const row of results ?? []) {
    const action: RetentionAction = row.action === "anonymize" ? "anonymize" : "delete";
    policy.set(row.data_class, { days: Number(row.retention_days), action });
  }
  return policy;
}

function uploadedAt(object: R2ObjectLike): number {
  const value = object.uploaded instanceof Date ? object.uploaded : new Date(object.uploaded);
  return value.getTime();
}

async function purgePrefix(
  bucket: RetentionBucket,
  prefix: string,
  cutoff: number,
): Promise<number> {
  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      limit: LIST_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      // Defence in depth: never act outside the requested prefix, and never
      // on the global shared analysis data even if a mock returns it.
      if (!object.key.startsWith(prefix) || object.key.startsWith("analysis/")) continue;
      const uploaded = uploadedAt(object);
      if (Number.isFinite(uploaded) && uploaded < cutoff) expired.push(object.key);
    }
    cursor = page.truncated && page.cursor ? page.cursor : undefined;
  } while (cursor);

  for (let index = 0; index < expired.length; index += DELETE_BATCH_SIZE) {
    await bucket.delete(expired.slice(index, index + DELETE_BATCH_SIZE));
  }
  return expired.length;
}

/** Delete expired original recordings and decode/acoustic checkpoints.
 *  `analysis/` is never listed, so shared model data cannot be purged. */
export async function purgeExpiredR2(
  bucket: RetentionBucket,
  policy: RetentionPolicy,
  now: number,
): Promise<RetentionR2Result> {
  const speakingRule = ruleFor(policy, "speaking_audio");
  const checkpointRule = ruleFor(policy, "review_checkpoints");
  return {
    speakingDeleted: speakingRule.action === "delete"
      ? await purgePrefix(bucket, R2_PURGE_PREFIXES.speakingDeleted, cutoffFor(now, speakingRule))
      : 0,
    checkpointsDeleted: checkpointRule.action === "delete"
      ? await purgePrefix(
        bucket,
        R2_PURGE_PREFIXES.checkpointsDeleted,
        cutoffFor(now, checkpointRule),
      )
      : 0,
  };
}

/** Strip tenant/task attribution from audit events past the retention window.
 *  Only rows that still carry a user_id are updated, so idempotent re-runs
 *  report zero. The event row itself is retained (audit integrity). */
export async function anonymizeOldAudit(
  db: RetentionDb,
  policy: RetentionPolicy,
  now: number,
): Promise<number> {
  const rule = ruleFor(policy, "audit_events");
  if (rule.action !== "anonymize") return 0;
  const result = await db.prepare(
    "UPDATE analysis_events SET user_id=NULL, task_id=NULL, metadata_json=NULL " +
    "WHERE at < ? AND user_id IS NOT NULL",
  ).bind(cutoffFor(now, rule)).run();
  const changes = Number(result.meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
}

/** Full scheduled sweep: seed policy (idempotent), purge expired R2 objects,
 *  then anonymize old audit attribution. Returns a content-free manifest. */
export async function runRetention(
  db: RetentionDb,
  bucket: RetentionBucket,
  now = Date.now(),
): Promise<RetentionManifest> {
  await seedRetentionPolicy(db, now);
  const policy = await getRetentionPolicy(db);
  const r2 = await purgeExpiredR2(bucket, policy, now);
  const auditAnonymized = await anonymizeOldAudit(db, policy, now);
  return { r2, auditAnonymized, ranAt: now };
}