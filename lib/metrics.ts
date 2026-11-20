// MT-4 observability (design rev3.1 §4.8, G9/F9/S19).
//
// Two content-blind signals are produced here:
//   * per-tenant daily metrics (tenant_metrics_daily): queue state counts,
//     oldest queued timestamp, last activity, spend and audio bytes. Learner
//     content (answers, feedback, lessons, transcripts) is never selected.
//   * service-level runner heartbeat (service_heartbeats): the S19 health
//     signal for a service principal, not attributed to a single tenant.
//
// aggregateTenantMetrics is invoked from the Worker scheduled handler with the
// raw D1 binding (env.DB), alongside retention. Raw `prepare` is used because
// the scheduled context has no request-scoped Drizzle client.

interface D1ResultLike {
  meta?: { changes?: number };
}

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<D1ResultLike>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

/** Minimal D1 surface used here. The scheduled handler passes `env.DB`; tests
 *  pass the same prepare/bind/run shape as the other lib modules. */
export interface MetricsDb {
  prepare(query: string): D1StatementLike;
}

/** `retry_wait` is a scheduled retry, so it is still waiting on the runner and
 *  is folded into `queued` rather than a separate column. */
export const QUEUED_STATES = ["queued", "retry_wait"] as const;

/** How long a queued task may sit before it raises an alert. */
export const DEFAULT_STALE_QUEUE_THRESHOLD_MS = 30 * 60 * 1000;

/** Statuses that count as a successful service run for last_success_at. */
const SUCCESS_STATUSES = new Set(["ok", "success", "finished", "completed", "healthy"]);

export interface TenantMetric {
  userId: string;
  utcDay: string;
  queued: number;
  completed: number;
  failed: number;
  blocked: number;
  needsAttention: number;
  costMicroCny: number;
  audioBytes: number;
  oldestQueuedAt: number | null;
  lastActiveAt: number | null;
  updatedAt: number;
}

export interface ServiceHeartbeatInput {
  serviceId: string;
  generation?: number;
  clientRunId?: string | null;
  status: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  /** Defaults to `now` for success-like statuses, else null (preserve prior). */
  lastSuccessAt?: number | null;
  nextExpectedAt?: number | null;
  detail?: string | null;
  processed?: number;
  now?: number;
}

export interface StaleQueueAlert {
  userId: string;
  oldestQueuedAt: number;
  ageMs: number;
}

/** YYYY-MM-DD in UTC. */
export function utcDay(now: number | Date = Date.now()): string {
  const value = now instanceof Date ? now : new Date(now);
  return value.toISOString().slice(0, 10);
}

function toCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function toTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

interface AggregateRow {
  user_id: string;
  queued: unknown;
  completed: unknown;
  failed: unknown;
  blocked: unknown;
  needs_attention: unknown;
  oldest_queued_at: unknown;
  last_active_at: unknown;
  cost_micro_cny: unknown;
  audio_bytes: unknown;
}

// One grouped pass over the tenant's tasks. The ledger and usage joins are
// restricted to the target day and are unique per (user_id, utc_day), so they
// cannot multiply the task counts. MAX() projects the scalar aggregate safely.
const AGGREGATE_QUERY = `
SELECT
  t.user_id AS user_id,
  SUM(CASE WHEN t.state IN ('queued', 'retry_wait') THEN 1 ELSE 0 END) AS queued,
  SUM(CASE WHEN t.state = 'completed' THEN 1 ELSE 0 END) AS completed,
  SUM(CASE WHEN t.state = 'failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
  SUM(CASE WHEN t.state = 'needs_attention' THEN 1 ELSE 0 END) AS needs_attention,
  MIN(CASE WHEN t.state IN ('queued', 'retry_wait') THEN t.created_at END) AS oldest_queued_at,
  MAX(t.updated_at) AS last_active_at,
  COALESCE(MAX(l.spent_micro_cny), 0) AS cost_micro_cny,
  COALESCE(MAX(u.audio_bytes), 0) AS audio_bytes
FROM review_tasks t
LEFT JOIN user_cost_ledger l ON l.user_id = t.user_id AND l.utc_day = ?
LEFT JOIN user_usage_daily u ON u.user_id = t.user_id AND u.utc_day = ?
GROUP BY t.user_id
ORDER BY t.user_id
`;

const UPSERT_METRICS = `
INSERT INTO tenant_metrics_daily
  (user_id, utc_day, queued, completed, failed, blocked, needs_attention,
   cost_micro_cny, audio_bytes, oldest_queued_at, last_active_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id, utc_day) DO UPDATE SET
  queued = excluded.queued,
  completed = excluded.completed,
  failed = excluded.failed,
  blocked = excluded.blocked,
  needs_attention = excluded.needs_attention,
  cost_micro_cny = excluded.cost_micro_cny,
  audio_bytes = excluded.audio_bytes,
  oldest_queued_at = excluded.oldest_queued_at,
  last_active_at = excluded.last_active_at,
  updated_at = excluded.updated_at
`;

/**
 * Aggregate every tenant that owns at least one review task into
 * tenant_metrics_daily for the UTC day containing `now`.
 *
 * Counts and timings only: no learner content is read or written. The UPSERT is
 * idempotent, so a re-run (or a retried scheduled invocation) updates the
 * existing row instead of inserting a duplicate.
 *
 * @returns the number of tenants written.
 */
export async function aggregateTenantMetrics(
  db: MetricsDb,
  now: number = Date.now(),
): Promise<number> {
  const day = utcDay(now);
  const { results } = await db.prepare(AGGREGATE_QUERY)
    .bind(day, day)
    .all<AggregateRow>();
  const rows = results ?? [];

  for (const row of rows) {
    await db.prepare(UPSERT_METRICS).bind(
      String(row.user_id),
      day,
      toCount(row.queued),
      toCount(row.completed),
      toCount(row.failed),
      toCount(row.blocked),
      toCount(row.needs_attention),
      toCount(row.cost_micro_cny),
      toCount(row.audio_bytes),
      toTimestamp(row.oldest_queued_at),
      toTimestamp(row.last_active_at),
      now,
    ).run();
  }

  return rows.length;
}

const UPSERT_HEARTBEAT = `
INSERT INTO service_heartbeats
  (service_id, generation, client_run_id, started_at, finished_at,
   last_success_at, next_expected_at, status, detail, processed, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(service_id) DO UPDATE SET
  generation = excluded.generation,
  client_run_id = excluded.client_run_id,
  started_at = excluded.started_at,
  finished_at = excluded.finished_at,
  -- A failed/missed run must not erase the timestamp of the last good run.
  last_success_at = COALESCE(excluded.last_success_at, service_heartbeats.last_success_at),
  next_expected_at = excluded.next_expected_at,
  status = excluded.status,
  detail = excluded.detail,
  processed = excluded.processed,
  updated_at = excluded.updated_at
`;

/**
 * Record the S19 service-level heartbeat. One row per service principal
 * (runner/coach), upserted so the latest generation/status wins while the last
 * successful run time is preserved across failures.
 */
export async function recordServiceHeartbeat(
  db: MetricsDb,
  input: ServiceHeartbeatInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  const lastSuccessAt = input.lastSuccessAt
    ?? (SUCCESS_STATUSES.has(input.status) ? now : null);

  await db.prepare(UPSERT_HEARTBEAT).bind(
    input.serviceId,
    Number(input.generation ?? 0),
    input.clientRunId ?? null,
    toTimestamp(input.startedAt),
    toTimestamp(input.finishedAt),
    toTimestamp(lastSuccessAt),
    toTimestamp(input.nextExpectedAt),
    input.status,
    input.detail ?? null,
    Number(input.processed ?? 0),
    now,
  ).run();
}

interface MetricRow {
  user_id: unknown;
  utc_day: unknown;
  queued: unknown;
  completed: unknown;
  failed: unknown;
  blocked: unknown;
  needs_attention: unknown;
  cost_micro_cny: unknown;
  audio_bytes: unknown;
  oldest_queued_at: unknown;
  last_active_at: unknown;
  updated_at: unknown;
}

const SUMMARY_QUERY = `
SELECT user_id, utc_day, queued, completed, failed, blocked, needs_attention,
       cost_micro_cny, audio_bytes, oldest_queued_at, last_active_at, updated_at
FROM tenant_metrics_daily
WHERE utc_day = ?
ORDER BY user_id
`;

/** Admin aggregate view for one UTC day. Content-blind: counts/timings only. */
export async function metricsSummary(db: MetricsDb, day: string): Promise<TenantMetric[]> {
  const { results } = await db.prepare(SUMMARY_QUERY).bind(day).all<MetricRow>();
  return (results ?? []).map(row => ({
    userId: String(row.user_id),
    utcDay: String(row.utc_day),
    queued: toCount(row.queued),
    completed: toCount(row.completed),
    failed: toCount(row.failed),
    blocked: toCount(row.blocked),
    needsAttention: toCount(row.needs_attention),
    costMicroCny: toCount(row.cost_micro_cny),
    audioBytes: toCount(row.audio_bytes),
    oldestQueuedAt: toTimestamp(row.oldest_queued_at),
    lastActiveAt: toTimestamp(row.last_active_at),
    updatedAt: toCount(row.updated_at),
  }));
}

interface StaleRow {
  user_id: unknown;
  oldest_queued_at: unknown;
}

const STALE_QUERY = `
SELECT user_id, MIN(oldest_queued_at) AS oldest_queued_at
FROM tenant_metrics_daily
WHERE oldest_queued_at IS NOT NULL AND oldest_queued_at < ?
GROUP BY user_id
ORDER BY oldest_queued_at ASC
`;

/**
 * Tenants whose oldest queued task has been waiting longer than `thresholdMs`.
 * Uses MIN across stored days, so a queue that went stale yesterday still
 * alerts until the aggregation observes it cleared.
 */
export async function staleQueueAlerts(
  db: MetricsDb,
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_STALE_QUEUE_THRESHOLD_MS,
): Promise<StaleQueueAlert[]> {
  const windowMs = Number.isFinite(thresholdMs) && thresholdMs >= 0
    ? thresholdMs
    : DEFAULT_STALE_QUEUE_THRESHOLD_MS;
  const cutoff = now - windowMs;
  const { results } = await db.prepare(STALE_QUERY).bind(cutoff).all<StaleRow>();
  return (results ?? []).flatMap(row => {
    const oldestQueuedAt = toTimestamp(row.oldest_queued_at);
    if (oldestQueuedAt === null) return [];
    return [{
      userId: String(row.user_id),
      oldestQueuedAt,
      ageMs: now - oldestQueuedAt,
    }];
  });
}