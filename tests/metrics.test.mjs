// MT-4 per-tenant metrics aggregation + service heartbeat against real SQLite
// (node:sqlite). Verifies state counting, idempotent upserts, tenant isolation,
// stale-queue alerting and the content-blind admin summary.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env={};", shortCircuit: true };
    }
    if (specifier === "@/db") {
      return { url: "data:text/javascript,export function getDb(){throw new Error('not used')}", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      return { url: new URL("../" + specifier.slice(2) + ".ts", import.meta.url).href, shortCircuit: true };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)
      && context.parentURL?.endsWith(".ts")) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);

const {
  aggregateTenantMetrics, DEFAULT_STALE_QUEUE_THRESHOLD_MS, metricsSummary,
  recordServiceHeartbeat, staleQueueAlerts, utcDay,
} = await import("../lib/metrics.ts");

function createDb() {
  const sql = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) {
    sql.exec(readFileSync("drizzle/" + file, "utf8"));
  }
  const statement = (query, args = []) => ({
    bind: (...values) => statement(query, [...args, ...values]),
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() {
      const result = sql.prepare(query).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return {
    sql,
    d1: { prepare: query => statement(query) },
  };
}

function insertTask(sql, {
  id = randomUUID(),
  userId,
  state,
  createdAt,
  updatedAt,
}) {
  sql.prepare(`INSERT INTO review_tasks
    (id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,lease_until,next_at,created_at,updated_at)
    VALUES (?,?,?,'text',?,12,22,'read_input',?,?,?,?,?)`)
    .run(id, "job-" + id, userId, "attempt-" + id, state, null, createdAt, createdAt, updatedAt);
  return id;
}

function insertCost(sql, userId, day, spentMicroCny) {
  sql.prepare(`INSERT INTO user_cost_ledger(user_id,utc_day,spent_micro_cny,paused,updated_at)
    VALUES (?,?,?,0,?)`).run(userId, day, spentMicroCny, NOW);
}

function insertUsage(sql, userId, day, audioBytes) {
  sql.prepare(`INSERT INTO user_usage_daily(user_id,utc_day,submissions,audio_bytes,model_calls,updated_at)
    VALUES (?,?,?,?,?,?)`).run(userId, day, 1, audioBytes, 1, NOW);
}

function insertMetric(sql, {
  userId, day = utcDay(NOW), queued = 0, completed = 0, failed = 0, blocked = 0,
  needsAttention = 0, costMicroCny = 0, audioBytes = 0, oldestQueuedAt = null,
  lastActiveAt = null, updatedAt = NOW,
}) {
  sql.prepare(`INSERT INTO tenant_metrics_daily
    (user_id,utc_day,queued,completed,failed,blocked,needs_attention,cost_micro_cny,
     audio_bytes,oldest_queued_at,last_active_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, day, queued, completed, failed, blocked, needsAttention, costMicroCny,
      audioBytes, oldestQueuedAt, lastActiveAt, updatedAt);
}

const metricRow = (sql, userId, day = utcDay(NOW)) =>
  sql.prepare("SELECT * FROM tenant_metrics_daily WHERE user_id=? AND utc_day=?").get(userId, day);

test("aggregateTenantMetrics counts states, oldest queue, cost and audio per tenant", async () => {
  const { sql, d1 } = createDb();
  const day = utcDay(NOW);

  insertTask(sql, { userId: "user-a", state: "queued", createdAt: NOW - 3 * HOUR, updatedAt: NOW - 3 * HOUR });
  insertTask(sql, { userId: "user-a", state: "retry_wait", createdAt: NOW - 2 * HOUR, updatedAt: NOW - 2 * HOUR });
  insertTask(sql, { userId: "user-a", state: "running", createdAt: NOW - 4 * HOUR, updatedAt: NOW - 30 * MINUTE });
  insertTask(sql, { userId: "user-a", state: "completed", createdAt: NOW - 5 * HOUR, updatedAt: NOW - 10 * MINUTE });
  insertTask(sql, { userId: "user-a", state: "blocked", createdAt: NOW - 5 * HOUR, updatedAt: NOW - 20 * MINUTE });
  insertTask(sql, { userId: "user-a", state: "needs_attention", createdAt: NOW - 6 * HOUR, updatedAt: NOW - 15 * MINUTE });
  insertTask(sql, { userId: "user-a", state: "failed", createdAt: NOW - 6 * HOUR, updatedAt: NOW - 12 * MINUTE });
  insertCost(sql, "user-a", day, 1250);
  insertUsage(sql, "user-a", day, 4096);

  assert.equal(await aggregateTenantMetrics(d1, NOW), 1, "one tenant written");

  const row = metricRow(sql, "user-a");
  assert.equal(row.utc_day, day);
  assert.equal(row.queued, 2, "queued + retry_wait share the queued bucket");
  assert.equal(row.completed, 1);
  assert.equal(row.failed, 1);
  assert.equal(row.blocked, 1);
  assert.equal(row.needs_attention, 1);
  assert.equal(row.oldest_queued_at, NOW - 3 * HOUR);
  assert.equal(row.last_active_at, NOW - 10 * MINUTE);
  assert.equal(row.cost_micro_cny, 1250);
  assert.equal(row.audio_bytes, 4096);
  assert.equal(row.updated_at, NOW);
});

test("aggregateTenantMetrics upserts idempotently and refreshes counters", async () => {
  const { sql, d1 } = createDb();
  const taskId = insertTask(sql, {
    userId: "user-a", state: "queued", createdAt: NOW - HOUR, updatedAt: NOW - HOUR,
  });

  assert.equal(await aggregateTenantMetrics(d1, NOW), 1);
  assert.equal(await aggregateTenantMetrics(d1, NOW + 1_000), 1, "re-run reports the same tenant");
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM tenant_metrics_daily").get().count, 1,
    "UPSERT does not duplicate the day row");
  assert.equal(metricRow(sql, "user-a").updated_at, NOW + 1_000, "re-run refreshes updated_at");

  // A state change is reflected by the next deterministic recomputation.
  sql.prepare("UPDATE review_tasks SET state='completed', updated_at=? WHERE id=?").run(NOW + 2_000, taskId);
  assert.equal(await aggregateTenantMetrics(d1, NOW + 3_000), 1);
  const row = metricRow(sql, "user-a");
  assert.equal(row.queued, 0);
  assert.equal(row.completed, 1);
  assert.equal(row.oldest_queued_at, null, "no queued tasks means no oldest queued timestamp");
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM tenant_metrics_daily").get().count, 1);
});

test("aggregateTenantMetrics keeps tenants separate", async () => {
  const { sql, d1 } = createDb();
  const day = utcDay(NOW);

  insertTask(sql, { userId: "user-a", state: "queued", createdAt: NOW - HOUR, updatedAt: NOW - HOUR });
  insertTask(sql, { userId: "user-a", state: "completed", createdAt: NOW - 2 * HOUR, updatedAt: NOW - 2 * HOUR });
  insertTask(sql, { userId: "user-b", state: "needs_attention", createdAt: NOW - 3 * HOUR, updatedAt: NOW - 3 * HOUR });
  insertCost(sql, "user-a", day, 100);
  insertCost(sql, "user-b", day, 250);
  insertUsage(sql, "user-a", day, 10);
  insertUsage(sql, "user-b", day, 20);

  assert.equal(await aggregateTenantMetrics(d1, NOW), 2);

  const a = metricRow(sql, "user-a");
  const b = metricRow(sql, "user-b");
  assert.deepEqual(
    { queued: a.queued, completed: a.completed, needs_attention: a.needs_attention, cost: a.cost_micro_cny, audio: a.audio_bytes },
    { queued: 1, completed: 1, needs_attention: 0, cost: 100, audio: 10 },
  );
  assert.deepEqual(
    { queued: b.queued, completed: b.completed, needs_attention: b.needs_attention, cost: b.cost_micro_cny, audio: b.audio_bytes },
    { queued: 0, completed: 0, needs_attention: 1, cost: 250, audio: 20 },
  );
  assert.equal(a.oldest_queued_at, NOW - HOUR);
  assert.equal(b.oldest_queued_at, null, "user B has no queued tasks");
});

test("recordServiceHeartbeat upserts generation/status and preserves last success", async () => {
  const { sql, d1 } = createDb();

  await recordServiceHeartbeat(d1, {
    serviceId: "runner-a", generation: 1, clientRunId: "run-1", status: "running",
    startedAt: NOW - 1_000, nextExpectedAt: NOW + HOUR, detail: "started", processed: 0, now: NOW,
  });
  let row = sql.prepare("SELECT * FROM service_heartbeats WHERE service_id=?").get("runner-a");
  assert.equal(row.generation, 1);
  assert.equal(row.status, "running");
  assert.equal(row.last_success_at, null);

  await recordServiceHeartbeat(d1, {
    serviceId: "runner-a", generation: 2, clientRunId: "run-2", status: "finished",
    startedAt: NOW - 1_000, finishedAt: NOW + 4_000, nextExpectedAt: NOW + 2 * HOUR,
    detail: "done", processed: 7, now: NOW + 5_000,
  });
  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM service_heartbeats").get().count, 1,
    "one row per service principal");
  row = sql.prepare("SELECT * FROM service_heartbeats WHERE service_id=?").get("runner-a");
  assert.equal(row.generation, 2);
  assert.equal(row.status, "finished");
  assert.equal(row.client_run_id, "run-2");
  assert.equal(row.finished_at, NOW + 4_000);
  assert.equal(row.next_expected_at, NOW + 2 * HOUR);
  assert.equal(row.processed, 7);
  assert.equal(row.updated_at, NOW + 5_000);
  assert.equal(row.last_success_at, NOW + 5_000, "success-like status stamps last_success_at");

  await recordServiceHeartbeat(d1, {
    serviceId: "runner-a", generation: 3, clientRunId: "run-3", status: "missing",
    nextExpectedAt: NOW + 3 * HOUR, detail: "no heartbeat", processed: 0, now: NOW + 10_000,
  });
  row = sql.prepare("SELECT * FROM service_heartbeats WHERE service_id=?").get("runner-a");
  assert.equal(row.generation, 3);
  assert.equal(row.status, "missing");
  assert.equal(row.last_success_at, NOW + 5_000, "a failed run never erases the last success");
});

test("staleQueueAlerts flags only queues older than the threshold", async () => {
  const { sql, d1 } = createDb();
  insertMetric(sql, { userId: "user-old", oldestQueuedAt: NOW - 2 * HOUR, queued: 3 });
  // A second (older) day row for the same tenant: MIN wins.
  insertMetric(sql, { userId: "user-old", day: "2026-11-19", oldestQueuedAt: NOW - 3 * HOUR, queued: 3 });
  insertMetric(sql, { userId: "user-fresh", oldestQueuedAt: NOW - 5 * MINUTE, queued: 1 });
  insertMetric(sql, { userId: "user-idle", oldestQueuedAt: null, queued: 0 });

  const alerts = await staleQueueAlerts(d1, NOW, HOUR);
  assert.deepEqual(alerts.map(alert => alert.userId), ["user-old"], "fresh/idle tenants are not flagged");
  assert.equal(alerts[0].oldestQueuedAt, NOW - 3 * HOUR, "oldest observation across days");
  assert.equal(alerts[0].ageMs, 3 * HOUR);

  assert.equal(DEFAULT_STALE_QUEUE_THRESHOLD_MS, 30 * MINUTE);
  const defaultAlerts = await staleQueueAlerts(d1, NOW);
  assert.deepEqual(defaultAlerts.map(alert => alert.userId), ["user-old"]);
});

test("metricsSummary returns counts and timings only (no learner content)", async () => {
  const { sql, d1 } = createDb();
  const day = utcDay(NOW);
  const secret = "SECRET-ANSWER-CONTENT";
  sql.prepare("INSERT INTO learner_states(user_id,revision,state) VALUES (?,?,?)")
    .run("user-a", 1, JSON.stringify({ answer: secret }));

  insertMetric(sql, {
    userId: "user-b", day, queued: 2, completed: 4, failed: 1, blocked: 0,
    needsAttention: 3, costMicroCny: 900, audioBytes: 2048,
    oldestQueuedAt: NOW - HOUR, lastActiveAt: NOW - MINUTE, updatedAt: NOW,
  });
  insertMetric(sql, { userId: "user-a", day, queued: 1, updatedAt: NOW });
  insertMetric(sql, { userId: "user-a", day: "2026-11-19", queued: 9, updatedAt: NOW });

  const summary = await metricsSummary(d1, day);
  assert.deepEqual(summary.map(entry => entry.userId), ["user-a", "user-b"], "one row per tenant for the day");
  const b = summary.find(entry => entry.userId === "user-b");
  assert.deepEqual(b, {
    userId: "user-b", utcDay: day, queued: 2, completed: 4, failed: 1, blocked: 0,
    needsAttention: 3, costMicroCny: 900, audioBytes: 2048,
    oldestQueuedAt: NOW - HOUR, lastActiveAt: NOW - MINUTE, updatedAt: NOW,
  });
  assert.deepEqual(Object.keys(b).sort(), [
    "audioBytes", "blocked", "completed", "costMicroCny", "failed", "lastActiveAt",
    "needsAttention", "oldestQueuedAt", "queued", "updatedAt", "userId", "utcDay",
  ]);
  assert.ok(!JSON.stringify(summary).includes(secret), "no learner content leaks into the summary");
});