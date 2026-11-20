// MT-3 retention policy + purge logic against real SQLite (node:sqlite) and a
// mock R2 bucket. Verifies seeding, R2 prefix purge (never analysis/), audit
// anonymization, and the scheduled manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);

const {
  DEFAULT_RETENTION, anonymizeOldAudit, getRetentionPolicy, purgeExpiredR2,
  runRetention, seedRetentionPolicy,
} = await import("../lib/retention.ts");

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

function createBucket() {
  const objects = new Map();
  const deleteCalls = [];
  return {
    objects,
    deleteCalls,
    put(key, uploaded) {
      objects.set(key, { uploaded: new Date(uploaded), size: 1 });
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + limit);
      return {
        objects: slice.map(key => ({ key, uploaded: objects.get(key).uploaded, size: 1 })),
        truncated: start + limit < keys.length,
        cursor: String(start + limit),
      };
    },
    async delete(keys) {
      deleteCalls.push(keys);
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

function insertEvent(sql, { at, userId = null, taskId = null, metadata = null, event = "review" }) {
  sql.prepare("INSERT INTO analysis_events (at, task_id, user_id, event, outcome, metadata_json) VALUES (?,?,?,?,?,?)")
    .run(at, taskId, userId, event, "ok", metadata);
}

test("seedRetentionPolicy is idempotent and seeds the design defaults", async () => {
  const { sql, d1 } = createDb();
  await seedRetentionPolicy(d1, NOW);
  await seedRetentionPolicy(d1, NOW + 1_000);

  const rows = sql.prepare("SELECT data_class, retention_days, action FROM retention_policy ORDER BY data_class").all();
  assert.equal(rows.length, 6, "one row per data class");
  assert.deepEqual(
    Object.fromEntries(rows.map(row => [row.data_class, { days: row.retention_days, action: row.action }])),
    {
      audit_events: { days: 365, action: "anonymize" },
      backup_archives: { days: 30, action: "delete" },
      review_checkpoints: { days: 7, action: "delete" },
      runner_cache: { days: 7, action: "delete" },
      runner_logs: { days: 30, action: "delete" },
      speaking_audio: { days: 90, action: "delete" },
    },
  );
  assert.deepEqual(DEFAULT_RETENTION.audit_events, { days: 365, action: "anonymize" });

  // Operator overrides survive a re-seed.
  sql.prepare("UPDATE retention_policy SET retention_days=30 WHERE data_class='speaking_audio'").run();
  await seedRetentionPolicy(d1, NOW + 2_000);
  assert.equal(
    sql.prepare("SELECT retention_days FROM retention_policy WHERE data_class='speaking_audio'").get().retention_days,
    30,
  );
});

test("purgeExpiredR2 deletes old speaking/checkpoint objects and never analysis/", async () => {
  const { d1 } = createDb();
  await seedRetentionPolicy(d1, NOW);
  const policy = await getRetentionPolicy(d1);
  const bucket = createBucket();

  bucket.put("speaking/u1/old-recording", NOW - 91 * DAY_MS);
  bucket.put("speaking/u1/new-recording", NOW - 89 * DAY_MS);
  bucket.put("review-checkpoints/u1/t1/old-digest", NOW - 8 * DAY_MS);
  bucket.put("review-checkpoints/u1/t1/new-digest", NOW - 6 * DAY_MS);
  bucket.put("analysis/v1/shared-model", NOW - 1_000 * DAY_MS);
  bucket.put("analysis/v1/second-shared-model", NOW - 1_000 * DAY_MS);

  const result = await purgeExpiredR2(bucket, policy, NOW);
  assert.deepEqual(result, { speakingDeleted: 1, checkpointsDeleted: 1 });

  assert.equal(bucket.objects.has("speaking/u1/old-recording"), false);
  assert.equal(bucket.objects.has("review-checkpoints/u1/t1/old-digest"), false);
  assert.equal(bucket.objects.has("speaking/u1/new-recording"), true, "fresh recording kept");
  assert.equal(bucket.objects.has("review-checkpoints/u1/t1/new-digest"), true, "fresh checkpoint kept");
  assert.equal(bucket.objects.has("analysis/v1/shared-model"), true, "global analysis data never purged");
  assert.equal(bucket.objects.has("analysis/v1/second-shared-model"), true);
  assert.ok(bucket.deleteCalls.every(call => Array.isArray(call)), "deletes are batched");
});

test("purgeExpiredR2 uses strict boundary semantics", async () => {
  const bucket = createBucket();
  const policy = new Map([
    ["speaking_audio", { days: 90, action: "delete" }],
    ["review_checkpoints", { days: 7, action: "delete" }],
  ]);
  bucket.put("speaking/u1/exactly-boundary", NOW - 90 * DAY_MS);
  bucket.put("review-checkpoints/u1/t/digest-exactly-boundary", NOW - 7 * DAY_MS);

  assert.deepEqual(await purgeExpiredR2(bucket, policy, NOW), { speakingDeleted: 0, checkpointsDeleted: 0 });
  assert.equal(bucket.objects.size, 2);
});

test("anonymizeOldAudit strips old attribution, keeps recent rows and is idempotent", async () => {
  const { sql, d1 } = createDb();
  await seedRetentionPolicy(d1, NOW);
  const policy = await getRetentionPolicy(d1);

  insertEvent(sql, {
    at: NOW - 366 * DAY_MS, userId: "user-old", taskId: "task-old",
    metadata: JSON.stringify({ artifactSha256: "a".repeat(64) }), event: "complete_review_task",
  });
  insertEvent(sql, { at: NOW - 1 * DAY_MS, userId: "user-new", taskId: "task-new", metadata: JSON.stringify({ ok: true }) });
  insertEvent(sql, { at: NOW - 366 * DAY_MS, userId: null, taskId: null, metadata: null });
  insertEvent(sql, { at: NOW - 365 * DAY_MS, userId: "user-boundary", taskId: "task-boundary", metadata: "{}" });

  assert.equal(await anonymizeOldAudit(d1, policy, NOW), 1);

  const old = sql.prepare("SELECT user_id, task_id, metadata_json, event, at FROM analysis_events WHERE event='complete_review_task'").get();
  assert.deepEqual({ ...old }, {
    user_id: null, task_id: null, metadata_json: null, event: "complete_review_task", at: NOW - 366 * DAY_MS,
  }, "event row retained with attribution removed");

  const recent = sql.prepare("SELECT user_id, task_id, metadata_json FROM analysis_events WHERE event='review' AND user_id='user-new'").get();
  assert.deepEqual({ ...recent }, { user_id: "user-new", task_id: "task-new", metadata_json: JSON.stringify({ ok: true }) });

  const boundary = sql.prepare("SELECT user_id FROM analysis_events WHERE user_id='user-boundary'").get();
  assert.equal(boundary.user_id, "user-boundary", "rows at the exact boundary are kept");

  assert.equal(await anonymizeOldAudit(d1, policy, NOW), 0, "re-run is a no-op");
});

test("runRetention seeds, purges and anonymizes with a content-free manifest", async () => {
  const { sql, d1 } = createDb();
  const bucket = createBucket();
  bucket.put("speaking/u1/old", NOW - 91 * DAY_MS);
  bucket.put("speaking/u1/new", NOW - 1 * DAY_MS);
  bucket.put("review-checkpoints/u1/t/old", NOW - 8 * DAY_MS);
  bucket.put("analysis/v1/model", NOW - 500 * DAY_MS);
  insertEvent(sql, { at: NOW - 400 * DAY_MS, userId: "user-old", taskId: "task-old", metadata: "{}" });
  insertEvent(sql, { at: NOW - 10 * DAY_MS, userId: "user-new", taskId: "task-new", metadata: "{}" });

  const manifest = await runRetention(d1, bucket, NOW);
  assert.deepEqual(manifest, {
    r2: { speakingDeleted: 1, checkpointsDeleted: 1 },
    auditAnonymized: 1,
    ranAt: NOW,
  });

  assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM retention_policy").get().count, 6);
  assert.equal(bucket.objects.has("analysis/v1/model"), true);
  assert.equal(bucket.objects.has("speaking/u1/new"), true);
  assert.equal(sql.prepare("SELECT user_id FROM analysis_events WHERE task_id='task-new'").get().user_id, "user-new");
  const oldEvent = sql.prepare("SELECT user_id, task_id, metadata_json FROM analysis_events WHERE at < ?").get(NOW - 399 * DAY_MS);
  assert.deepEqual({ ...oldEvent }, { user_id: null, task_id: null, metadata_json: null });
});