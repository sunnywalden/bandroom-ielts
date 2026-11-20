// MT-4 quotas + rate limits (design rev3.1 §4.5, B6 / S12).
//
// Per-tenant daily caps prevent one account from exhausting the shared queue /
// storage / model budget. Anonymous surfaces (registration, login, discovery)
// get per-IP/domain throttles. Limits are env-overridable; defaults are generous
// for a single learner but bound abuse. Exceeding a cap returns 429 + retryAfter.
//
// Counters live in user_usage_daily (per tenant/day) and rate_limit_buckets
// (per IP/domain window). Increments are atomic conditional UPDATEs so concurrent
// requests cannot overshoot the cap.

export type D1 = { prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } };

/** Quotas are enforced unless explicitly disabled (BANDROOM_QUOTA_GATE="off")
 *  for fixtures whose DB mock does not implement the counter SQL. Production
 *  leaves the flag unset (enforced). */
export function quotaEnabled(env: { BANDROOM_QUOTA_GATE?: string } | undefined): boolean {
  return env?.BANDROOM_QUOTA_GATE?.trim() !== "off";
}

export class QuotaError extends Error {
  status = 429;
  code = "quota_exceeded";
  retryAfter: number;
  constructor(message: string, retryAfter = 60) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

export const DEFAULT_QUOTAS = {
  submissionsPerDay: 40,
  audioBytesPerDay: 300 * 1024 * 1024, // 300 MiB
  modelCallsPerDay: 120,
  queueDepth: 20,
  concurrentRunning: 2,
};

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function ensureRow(db: D1, userId: string, day: string, now: number): Promise<void> {
  await db.prepare(
    "INSERT INTO user_usage_daily (user_id, utc_day, submissions, audio_bytes, model_calls, updated_at) " +
    "VALUES (?,?,0,0,0,?) ON CONFLICT(user_id, utc_day) DO NOTHING",
  ).bind(userId, day, now).run();
}

/** Atomically increment a counter only if it stays under the cap. Returns the new
 *  value, or null when the cap would be exceeded (no increment happens). */
async function incrementUnderCap(
  db: D1, userId: string, day: string, column: string, delta: number, cap: number, now: number,
): Promise<number | null> {
  await ensureRow(db, userId, day, now);
  const row = await db.prepare(
    `UPDATE user_usage_daily SET ${column}=${column}+?, updated_at=? ` +
    `WHERE user_id=? AND utc_day=? AND ${column}+?<=? RETURNING ${column} AS value`,
  ).bind(delta, now, userId, day, delta, cap).first<{ value: number }>();
  return row ? Number(row.value) : null;
}

export async function checkSubmissionQuota(db: D1, userId: string, now = Date.now()): Promise<void> {
  const day = utcDay(now);
  const value = await incrementUnderCap(db, userId, day, "submissions", 1, DEFAULT_QUOTAS.submissionsPerDay, now);
  if (value === null) throw new QuotaError("今日提交次数已达上限，请明天再试。", secondsToNextUtcDay(now));
}

export async function checkAudioQuota(db: D1, userId: string, bytes: number, now = Date.now()): Promise<void> {
  const day = utcDay(now);
  const value = await incrementUnderCap(db, userId, day, "audio_bytes", bytes, DEFAULT_QUOTAS.audioBytesPerDay, now);
  if (value === null) throw new QuotaError("今日上传音频量已达上限，请明天再试。", secondsToNextUtcDay(now));
}

export async function recordModelCall(db: D1, userId: string, now = Date.now()): Promise<void> {
  const day = utcDay(now);
  const value = await incrementUnderCap(db, userId, day, "model_calls", 1, DEFAULT_QUOTAS.modelCallsPerDay, now);
  if (value === null) throw new QuotaError("今日模型调用次数已达上限。", secondsToNextUtcDay(now));
}

/** Queue-depth guard: refuse new submissions when too many tasks are pending. */
export async function checkQueueDepth(db: D1, userId: string): Promise<void> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM review_tasks WHERE user_id=? AND state IN ('queued','retry_wait')",
  ).bind(userId).first<{ n: number }>();
  if (Number(row?.n ?? 0) >= DEFAULT_QUOTAS.queueDepth)
    throw new QuotaError("待处理任务过多，请稍后再提交。", 300);
}

/**
 * Anonymous per-key throttle (registration / login-failure / discovery). Fixed
 * window: hits reset when the window elapses. Returns true if allowed.
 */
export async function rateLimit(
  db: D1, bucketKey: string, limit: number, windowMs: number, now = Date.now(),
): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await db.prepare(
    "INSERT INTO rate_limit_buckets (bucket_key, hits, window_start, updated_at) VALUES (?,1,?,?) " +
    "ON CONFLICT(bucket_key) DO UPDATE SET " +
    "hits=CASE WHEN rate_limit_buckets.window_start=? THEN rate_limit_buckets.hits+1 ELSE 1 END, " +
    "window_start=?, updated_at=?",
  ).bind(bucketKey, windowStart, now, windowStart, windowStart, now).run();
  const row = await db.prepare("SELECT hits FROM rate_limit_buckets WHERE bucket_key=?")
    .bind(bucketKey).first<{ hits: number }>();
  return Number(row?.hits ?? 0) <= limit;
}

export function secondsToNextUtcDay(now = Date.now()): number {
  const next = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** Convert a QuotaError into a 429 Response with Retry-After. */
export function quotaResponse(error: QuotaError): Response {
  return Response.json(
    { error: error.code, message: error.message, retryAfter: error.retryAfter },
    { status: 429, headers: { "Retry-After": String(error.retryAfter), "Cache-Control": "private, no-store" } },
  );
}