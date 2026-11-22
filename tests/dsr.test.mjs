// MT-3 DSR (design rev3.1 §4.7): export format 5, resumable full-storage
// deletion, cross-tenant isolation, idempotency, and the H19 per-row restore
// guard. Runs against node:sqlite + the Drizzle D1 driver with a mock R2 bucket.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { createHash, randomUUID } from "node:crypto";

globalThis.__dsrEnv = {};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env=globalThis.__dsrEnv", shortCircuit: true };
    }
    if (specifier === "@/db") {
      return { url: "data:text/javascript,export function getDb(){throw new Error('not used')};export function getTenantDb(){throw new Error('not used')};export function drizzleFromBinding(){throw new Error('not used')}", shortCircuit: true };
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

const migrations = readdirSync("drizzle").filter(file => file.endsWith(".sql")).sort()
  .map(file => readFileSync("drizzle/" + file, "utf8"));

const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");
const dsr = await import("../lib/dsr.ts");
const backup = await import("../lib/backup.ts");

const TENANT_TABLES = [
  "learner_states", "teacher_lessons", "teacher_feedback", "review_jobs",
  "review_tasks", "review_receipts", "analysis_artifacts", "personal_calibration",
  "calibration_candidates", "calibration_events", "automation_heartbeats",
  "user_cost_ledger", "consent_events", "scheduler_heartbeats", "user_tokens",
];

function makeEnv() {
  const sql = new DatabaseSync(":memory:");
  for (const migration of migrations) sql.exec(migration);

  function statement(query, args = []) {
    return {
      bind: (...values) => statement(query, [...args, ...values]),
      async first() { return sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      async raw() { return sql.prepare(query).all(...args).map(row => Object.values(row)); },
      async run() {
        const result = sql.prepare(query).run(...args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      // D1 batch returns SELECT rows too; mirror that without changing the
      // public run()/all() shapes used by Drizzle.
      async _execute() {
        if (/^\s*(select|with|pragma)/i.test(query)) {
          return { success: true, meta: { changes: 0 }, results: sql.prepare(query).all(...args) };
        }
        const result = sql.prepare(query).run(...args);
        return { success: true, meta: { changes: Number(result.changes) }, results: [] };
      },
    };
  }
  const d1 = {
    prepare: query => statement(query),
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const entry of statements) results.push(await entry._execute());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sql, d1, db: drizzle(d1, { schema }) };
}

class MockBucket {
  constructor() { this.objects = new Map(); }
  seed(key, text = "") {
    const bytes = new TextEncoder().encode(text);
    this.objects.set(key, {
      bytes,
      etag: createHash("md5").update(bytes).digest("hex"),
    });
    return this;
  }
  async put(key, value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes: bytes.slice(), etag: createHash("md5").update(bytes).digest("hex") });
    return { size: bytes.byteLength };
  }
  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + limit);
    return {
      objects: slice.map(key => ({
        key,
        size: this.objects.get(key).bytes.byteLength,
        etag: this.objects.get(key).etag,
      })),
      truncated: start + limit < keys.length,
      cursor: start + limit < keys.length ? String(start + limit) : undefined,
    };
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  keys() { return [...this.objects.keys()].sort(); }
}

function insertUser(sql, userId, { status = "active", email } = {}) {
  const now = 1_700_000_000_000;
  sql.prepare(`INSERT INTO users
    (user_id,idp_iss,idp_sub,email_normalized,display_name,role,status,
     consent_version,consent_at,revocation_epoch,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`)
    .run(userId, "https://idp.example", "sub-" + userId,
      (email ?? `${userId}@example.com`).toLowerCase(), "Display " + userId,
      "learner", status, "v1", now, now, now);
}

function seedTenant(sql, userId) {
  const now = 1_700_000_000_000;
  const jobId = `job-${userId}`;
  const taskId = `task-${userId}`;
  const receiptId = `receipt-${userId}`;
  const feedbackId = `fb-${userId}`;
  sql.prepare("INSERT INTO learner_states(user_id,revision,state) VALUES(?,?,?)")
    .run(userId, 3, JSON.stringify({ secret: `state-${userId}` }));
  sql.prepare("INSERT INTO teacher_lessons(user_id,day,lesson) VALUES(?,?,?)")
    .run(userId, 1, JSON.stringify({ secret: `lesson-${userId}` }));
  sql.prepare(`INSERT INTO teacher_feedback
    (id,user_id,day,stage,attempt,evidence,feedback,author_scope,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(feedbackId, userId, 1, "speak", "a", `evidence-${userId}`, `feedback-${userId}`, "coach", "2026-01-01");
  sql.prepare(`INSERT INTO review_jobs
    (id,user_id,day,submission_key,request_hash,revision,snapshot,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(jobId, userId, 1, `sub-${userId}`, "h".repeat(64), 1,
      JSON.stringify({ secret: `snapshot-${userId}` }), "2026-01-01");
  sql.prepare(`INSERT INTO review_tasks
    (id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,
     stage,state,lease_until,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, jobId, userId, "speaking", `attempt-${taskId}`, 1, 1, `rec-${userId}`,
      "read_input", "running", 9_999_999_999_999, now, now, now);
  sql.prepare(`INSERT INTO review_receipts
    (id,task_id,user_id,attempt_id,attempt_revision,fence,feedback_id,output_sha256,payload_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(receiptId, taskId, userId, `attempt-${taskId}`, 1, 1, feedbackId, "a".repeat(64),
      JSON.stringify({}), now);
  sql.prepare(`INSERT INTO analysis_artifacts
    (task_id,stage,chunk_index,analyzer_version,input_sha256,artifact_sha256,bytes,object_ref,payload_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, "decode", 0, "v1", "b".repeat(64), "c".repeat(64), 10, null,
      JSON.stringify({ secret: `artifact-${userId}` }), now);
  sql.prepare(`INSERT INTO analysis_events
    (at,task_id,user_id,fence,event,stage,outcome,metadata_json)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(now, taskId, userId, 1, "complete", "decode", "ok",
      JSON.stringify({ secret: `event-${userId}` }));
  sql.prepare(`INSERT INTO personal_calibration
    (user_id,expected,actual,rule_version,detector_version,inventory_version,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(userId, "th", "s", "r1", "d1", "i1", now);
  sql.prepare(`INSERT INTO calibration_candidates
    (candidate_id,user_id,attempt_id,recording_id,word,expected,actual,at_ms,detector_confidence,shown_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`cand-${userId}`, userId, `attempt-${taskId}`, `rec-${userId}`, "think", "th", "s", 0, 0.9, now);
  sql.prepare(`INSERT INTO calibration_events
    (user_id,attempt_id,candidate_id,expected,actual,verdict,is_catch_trial,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(userId, `attempt-${taskId}`, `cand-${userId}`, "th", "s", "confirmed", 0, now);
  sql.prepare("INSERT INTO automation_heartbeats(user_id,automation_id,generation,status) VALUES (?,?,?,?)")
    .run(userId, "auto", 0, "ok");
  sql.prepare("INSERT INTO user_cost_ledger(user_id,utc_day,spent_micro_cny,updated_at) VALUES (?,?,?,?)")
    .run(userId, "2026-11-20", 100, now);
  sql.prepare("INSERT INTO consent_events(user_id,version,purpose,at) VALUES (?,?,?,?)")
    .run(userId, "v1", "coach", now);
  sql.prepare("INSERT INTO scheduler_heartbeats(automation_id,owner_user_id,status) VALUES (?,?,?)")
    .run(`auto-${userId}`, userId, "ok");
  sql.prepare("INSERT INTO user_tokens(id,user_id,token_hash,label,created_at) VALUES (?,?,?,?,?)")
    .run(`tok-${userId}`, userId, `hash-${userId}`, "test", now);
  return { jobId, taskId, receiptId, feedbackId };
}

function count(sql, table, userId, column = "user_id") {
  return Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(userId).n);
}

function seedObjects(bucket, userId) {
  const uid = encodeURIComponent(userId);
  bucket.seed(`speaking/${uid}/rec-a`, "audio-a-" + userId);
  bucket.seed(`review-checkpoints/${uid}/task-a/digest-a`, "checkpoint-a-" + userId);
}

function failingDb(base, match) {
  let fired = false;
  const client = base.$client;
  const wrapped = {
    prepare(query) {
      const statement = client.prepare(query);
      return {
        ...statement,
        bind(...values) {
          const bound = statement.bind(...values);
          return {
            ...bound,
            async run() {
              if (!fired && query.includes(match)) {
                fired = true;
                throw new Error("injected delete failure");
              }
              return bound.run();
            },
            all: (...args) => bound.all(...args),
            first: (...args) => bound.first(...args),
          };
        },
      };
    },
  };
  return new Proxy(base, {
    get(target, property) {
      if (property === "$client") return wrapped;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("exportDsr (format 5) includes every tenant table, an R2 manifest, and no token material", async () => {
  const { sql, db } = makeEnv();
  const bucket = new MockBucket();
  const userId = "user-a-" + randomUUID();
  insertUser(sql, userId);
  seedTenant(sql, userId);
  seedObjects(bucket, userId);
  bucket.seed("analysis/v1/model.bin", "global-model-data");

  const out = await dsr.exportDsr(db, bucket, userId);

  assert.equal(out.format, "bandroom-dsr-export-v5");
  assert.equal(out.userId, userId);
  assert.ok(out.exportedAt);
  const expectedTables = [
    "learner_states", "teacher_lessons", "teacher_feedback", "review_jobs",
    "review_tasks", "review_receipts", "analysis_artifacts", "analysis_events",
    "personal_calibration", "calibration_candidates", "calibration_events",
    "automation_heartbeats", "user_cost_ledger", "consent_events",
    "scheduler_heartbeats", "users",
  ];
  for (const table of expectedTables) {
    assert.ok(Array.isArray(out.tables[table]), `table ${table} present`);
    assert.equal(out.tables[table].length, 1, `table ${table} scoped to the tenant`);
  }
  assert.equal(out.tables.teacher_feedback[0].author_scope, "coach");
  assert.equal(out.tables.users[0].email_normalized, `${userId}@example.com`);
  assert.equal(out.r2.speaking.length, 1);
  assert.equal(out.r2.reviewCheckpoints.length, 1);
  assert.ok(out.r2.speaking[0].key.startsWith(`speaking/${encodeURIComponent(userId)}/`));
  assert.ok(out.r2.speaking[0].size > 0);
  assert.ok(out.r2.speaking[0].etag);

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes(`hash-${userId}`), "no token hashes");
  assert.ok(!serialized.includes(`tok-${userId}`), "no token ids");
  assert.ok(!("user_tokens" in out.tables), "token table never exported");
  assert.ok(!serialized.includes("model.bin"), "global analysis objects are not tenant data");
  assert.ok(!serialized.includes("audio-a-" + userId), "audio bytes are not embedded, only manifest entries");
});

test("runDsrDelete removes tenant rows, pseudonymises audit rows, clears R2 and tombstones", async () => {
  const { sql, db } = makeEnv();
  const bucket = new MockBucket();
  const victim = "user-a-" + randomUUID();
  const other = "user-b-" + randomUUID();
  insertUser(sql, victim);
  insertUser(sql, other);
  seedTenant(sql, victim);
  seedTenant(sql, other);
  seedObjects(bucket, victim);
  seedObjects(bucket, other);
  bucket.seed("analysis/v1/model.bin", "global-model-data");
  bucket.seed(`speaking/${encodeURIComponent(other)}/keep`, "other-tenant-audio");

  const jobId = randomUUID();
  const result = await dsr.runDsrDelete(db, bucket, victim, jobId, "admin-1");

  assert.equal(result.status, "done");
  assert.equal(result.jobId, jobId);

  for (const table of TENANT_TABLES.filter(name =>
    !["user_tokens", "scheduler_heartbeats", "analysis_artifacts"].includes(name))) {
    assert.equal(count(sql, table, victim), 0, `${table} cleared`);
  }
  assert.equal(Number(sql.prepare("SELECT COUNT(*) AS n FROM analysis_artifacts WHERE task_id=?")
    .get(`task-${victim}`).n), 0, "analysis_artifacts cleared via task join");
  assert.equal(count(sql, "scheduler_heartbeats", victim, "owner_user_id"), 0, "legacy owner heartbeats cleared");
  // analysis_events are pseudonymised, not removed.
  const event = sql.prepare("SELECT user_id,task_id,metadata_json FROM analysis_events").get();
  assert.equal(event.user_id, null);
  assert.equal(event.task_id, null);
  assert.equal(event.metadata_json, null);
  assert.equal(Number(sql.prepare("SELECT COUNT(*) AS n FROM analysis_events WHERE user_id=?").get(victim).n), 0);

  const token = sql.prepare("SELECT revoked_at FROM user_tokens WHERE id=?").get(`tok-${victim}`);
  assert.ok(token.revoked_at > 0, "tokens revoked");
  const user = sql.prepare("SELECT status,email_normalized,display_name,revocation_epoch FROM users WHERE user_id=?").get(victim);
  assert.equal(user.status, "revoked");
  assert.equal(user.email_normalized, null);
  assert.equal(user.display_name, null);
  assert.ok(user.revocation_epoch >= 1);

  // Cross-tenant isolation: B's rows and objects survive intact.
  assert.equal(count(sql, "learner_states", other), 1);
  assert.equal(count(sql, "teacher_feedback", other), 1);
  assert.equal(count(sql, "analysis_events", other, "user_id"), 1);
  assert.equal(bucket.keys().filter(key => key.includes(encodeURIComponent(victim))).length, 0,
    "victim prefixes cleared");
  assert.ok(bucket.keys().some(key => key.startsWith(`speaking/${encodeURIComponent(other)}/`)));
  assert.ok(bucket.keys().includes("analysis/v1/model.bin"), "global analysis prefix untouched");

  const job = sql.prepare("SELECT status,manifest_json,finished_at FROM dsr_jobs WHERE id=?").get(jobId);
  assert.equal(job.status, "done");
  assert.ok(job.finished_at > 0);
  const manifest = JSON.parse(job.manifest_json);
  assert.equal(manifest.r2.speaking, 1);
  assert.equal(manifest.r2.reviewCheckpoints, 1);
  assert.equal(manifest.pseudonymized.analysis_events, 1);
  assert.equal(manifest.analysis_artifacts, 1);
  assert.equal(manifest.tombstoned, true);
  assert.match(manifest.disclosure, /time-travel|versioning/i);
});

test("a failed deletion preserves its cursor and resumes from the last good step", async () => {
  const { sql, db } = makeEnv();
  const bucket = new MockBucket();
  const userId = "user-a-" + randomUUID();
  insertUser(sql, userId);
  seedTenant(sql, userId);
  seedObjects(bucket, userId);

  const jobId = randomUUID();
  await assert.rejects(
    () => dsr.runDsrDelete(failingDb(db, "DELETE FROM review_jobs"), bucket, userId, jobId, "admin-1"),
    /injected delete failure/,
  );

  const failed = sql.prepare("SELECT status,cursor_json FROM dsr_jobs WHERE id=?").get(jobId);
  assert.equal(failed.status, "failed");
  const cursor = JSON.parse(failed.cursor_json);
  assert.equal(cursor.steps.analysisArtifacts, true);
  assert.equal(cursor.steps.reviewReceipts, true);
  assert.equal(cursor.steps.reviewTasks, true);
  assert.notEqual(cursor.steps.reviewJobs, true, "failed step is not marked done");
  assert.equal(count(sql, "review_receipts", userId), 0, "completed steps stayed deleted");
  assert.equal(count(sql, "review_jobs", userId), 1, "failed step rolled nothing forward");
  assert.equal(count(sql, "teacher_feedback", userId), 1, "later steps did not run");

  const result = await dsr.runDsrDelete(db, bucket, userId, jobId, "admin-1");
  assert.equal(result.status, "done");
  assert.equal(count(sql, "review_jobs", userId), 0);
  assert.equal(count(sql, "teacher_feedback", userId), 0);
  assert.equal(count(sql, "learner_states", userId), 0);
  assert.equal(sql.prepare("SELECT status FROM users WHERE user_id=?").get(userId).status, "revoked");
  assert.equal(bucket.keys().filter(key => key.includes(encodeURIComponent(userId))).length, 0);
});

test("re-running a completed job is a no-op and does not delete new rows", async () => {
  const { sql, db } = makeEnv();
  const bucket = new MockBucket();
  const userId = "user-a-" + randomUUID();
  insertUser(sql, userId);
  seedTenant(sql, userId);
  seedObjects(bucket, userId);

  const jobId = randomUUID();
  const first = await dsr.runDsrDelete(db, bucket, userId, jobId, "admin-1");
  assert.equal(first.status, "done");

  // Fresh rows written after completion must survive: a done job never re-runs.
  sql.prepare("INSERT INTO consent_events(user_id,version,purpose,at) VALUES (?,?,?,?)")
    .run(userId, "v2", "coach", 1);
  const second = await dsr.runDsrDelete(db, bucket, userId, jobId, "admin-1");
  assert.deepEqual(second, first);
  assert.equal(count(sql, "consent_events", userId), 1);
});

test("a job id cannot be reused for a different tenant", async () => {
  const { sql, db } = makeEnv();
  const bucket = new MockBucket();
  const a = "user-a-" + randomUUID();
  const b = "user-b-" + randomUUID();
  insertUser(sql, a);
  insertUser(sql, b);
  seedTenant(sql, a);
  const jobId = randomUUID();
  await dsr.runDsrDelete(db, bucket, a, jobId, "admin-1");
  await assert.rejects(() => dsr.runDsrDelete(db, bucket, b, jobId, "admin-1"), /dsr_job_conflict/);
});

test("H19: restoreBackup rejects a learner state larger than 1.5 MB", async () => {
  const source = makeEnv();
  const target = makeEnv();
  const bucket = new MockBucket();
  const userId = "user-a-" + randomUUID();
  const key = "f".repeat(64);
  insertUser(source.sql, userId);
  source.sql.prepare("INSERT INTO learner_states(user_id,revision,state) VALUES (?,?,?)")
    .run(userId, 1, JSON.stringify({ oversized: "x".repeat(1_600_000) }));

  const signed = await backup.exportBackup(source.d1, bucket, userId, key);
  await assert.rejects(
    () => backup.restoreBackup(target.d1, bucket, userId, key, signed, true),
    error => error instanceof backup.BackupError && error.status === 422
      && error.message === "备份记录超出单行大小限制。",
  );
  assert.equal(count(target.sql, "learner_states", userId), 0, "oversized row never inserted");
});