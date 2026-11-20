// Lease integration tests (design rev3.1 S1.1 + B1 + S7.1).
//
// Exercises the real review-tool dispatch against SQLite: a lease-verified
// write must use the signed tenant (never the caller's identity), wrong-op
// leases must be rejected, the legacy owner path must survive with no lease,
// the atomic users predicate must block suspended/revoked tenants, and the
// service audit must never attribute a foreign taskId without a verified lease.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";

const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort())
  sql.exec(readFileSync("drizzle/" + file, "utf8"));

function statement(query, args = []) {
  return {
    bind: (...values) => statement(query, [...args, ...values]),
    async first() { const s = sql.prepare(query); const row = s.all(...args)[0]; return row ? { ...row } : null; },
    async all() { const s = sql.prepare(query); return { results: s.all(...args).map(row => ({ ...row })) }; },
    async run() {
      const s = sql.prepare(query); const rows = s.all(...args);
      return { results: rows, meta: { changes: Number(sql.prepare("SELECT changes() AS n").get().n) } };
    },
  };
}
const d1 = {
  prepare: query => statement(query),
  async batch(statements) {
    sql.exec("BEGIN");
    try {
      const results = [];
      for (const s of statements) results.push(await s.run());
      sql.exec("COMMIT");
      return results;
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  },
};

const auditRows = [];
// Review tasks use getDb().$client; the audit layer uses the Drizzle builder.
// `select` throws on purpose: S7.1 forbids looking a task up to attribute it.
globalThis.testDb = {
  $client: d1,
  select() { throw new Error("service audit must not look up review_tasks"); },
  insert() {
    return { values(values) { return { run: async () => { auditRows.push(values); } }; } };
  },
};

const TEST_KEY = "a".repeat(64);
globalThis.__leaseEnv = {
  BANDROOM_LEASE_KEY: TEST_KEY,
  BANDROOM_LEASE_KID: "test-kid",
  BUCKET: undefined,
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "data:text/javascript,export const env=globalThis.__leaseEnv", shortCircuit: true };
    if (specifier === "@/db")
      return { url: "data:text/javascript,export function getDb(){return globalThis.testDb}", shortCircuit: true };
    if (specifier.startsWith("@/"))
      return { url: new URL("../" + specifier.slice(2) + ".ts", import.meta.url).href, shortCircuit: true };
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts") && context.parentURL?.endsWith(".ts"))
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  },
});

const { callReviewTool } = await import("../lib/review-tools.ts");
const { auditServiceCall } = await import("../lib/service-audit.ts");
const { signLease, verifyLease, leaseEnabled } = await import("../lib/lease.ts");
const { claimNextReviewTask } = await import("../lib/review-tasks.ts");

const OWNER = "env-owner";
const TENANT = "tenant-a";

function reset() {
  sql.exec(`DELETE FROM analysis_artifacts;
    DELETE FROM review_tasks;
    DELETE FROM review_jobs;
    DELETE FROM review_receipts;
    DELETE FROM teacher_feedback;
    DELETE FROM analysis_events;
    DELETE FROM users;
    DELETE FROM learner_states;`);
  auditRows.length = 0;
}

function seedUser(userId, { status = "active", revocationEpoch = 0 } = {}) {
  const now = Date.now();
  sql.prepare(`INSERT INTO users
    (user_id, idp_iss, idp_sub, email_normalized, role, status, revocation_epoch, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      status=excluded.status, revocation_epoch=excluded.revocation_epoch, updated_at=excluded.updated_at`)
    .run(userId, "issuer", userId, `${userId}@example.test`, "learner", status, revocationEpoch, now, now);
}

function insertJob(userId) {
  const jobId = "v2:" + randomUUID();
  const snapshot = {
    sourceId: "v1:fixture",
    attempt: {
      id: jobId, day: 12, field: "writeOriginal", index: 0, stage: "write",
      title: "Fixture", kind: "subjective", response: "Fixture answer", conditions: "", evidence: "",
    },
    context: { prompt: "Fixture prompt" },
  };
  sql.prepare("INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(jobId, userId, 12, randomUUID(), "a".repeat(64), 22, JSON.stringify(snapshot), new Date().toISOString());
  const taskId = randomUUID();
  const now = Date.now();
  sql.prepare(`INSERT INTO review_tasks
    (id, review_job_id, user_id, kind, attempt_id, day, attempt_revision, recording_id, analysis_version,
     stage, state, fence, attempts, next_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`)
    .run(taskId, jobId, userId, "text", jobId, 12, 22, null, null, now, now, now);
  return { taskId, jobId };
}

async function claimFor(userId) {
  insertJob(userId);
  const task = await claimNextReviewTask(d1, { clientRunId: "run-claim" });
  assert.ok(task, "task claimed");
  return task;
}

async function leaseFor(task, userId, ops, { exp = Date.now() + 300_000, rev = 0, rid = "runner-1" } = {}) {
  const token = await signLease({
    tid: task.id, uid: userId, fence: task.fence, rid, ops,
    iat: Date.now(), exp, rev,
  });
  assert.ok(token, "lease signed");
  return token;
}

function text(result) { return JSON.parse(result.content[0].text); }

test("claim_next_review_task signs the tenant's current revocation epoch", async () => {
  reset();
  seedUser(TENANT, { revocationEpoch: 3 });
  insertJob(TENANT);
  const claimed = text(await callReviewTool(OWNER, "claim_next_review_task", { clientRunId: "claim-run" }));
  assert.ok(claimed.lease, "claim returns a lease");
  const payload = await verifyLease(claimed.lease, "complete_review_task");
  assert.equal(payload.uid, TENANT);
  assert.equal(payload.tid, claimed.task.id);
  assert.equal(payload.rev, 3);
});

test("lease-verified completion uses lease.uid, not the caller userId", async () => {
  reset();
  seedUser(TENANT);
  const task = await claimFor(TENANT);
  const lease = await leaseFor(task, TENANT, ["complete_review_task"]);
  let reportedUid = null;
  const result = await callReviewTool(OWNER, "complete_review_task", {
    taskId: task.id, fence: task.fence, lease,
    feedback: "Text correction", evidence: "Text evidence",
  }, { onLeaseVerified: payload => { reportedUid = payload.uid; } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(reportedUid, TENANT, "verified lease reported to the audit layer");

  const feedback = sql.prepare("SELECT user_id FROM teacher_feedback WHERE review_task_id=?").get(task.id);
  const receipt = sql.prepare("SELECT user_id FROM review_receipts WHERE task_id=?").get(task.id);
  assert.equal(feedback.user_id, TENANT);
  assert.equal(receipt.user_id, TENANT);
  assert.equal(
    sql.prepare("SELECT COUNT(*) AS n FROM teacher_feedback WHERE user_id=?").get(OWNER).n, 0,
    "caller identity did not receive the write",
  );
});

test("lease with the wrong operation is rejected", async () => {
  reset();
  seedUser(TENANT);
  const task = await claimFor(TENANT);
  const lease = await leaseFor(task, TENANT, ["renew_review_lease"]);
  const result = await callReviewTool(TENANT, "complete_review_task", {
    taskId: task.id, fence: task.fence, lease,
    feedback: "Text correction", evidence: "Text evidence",
  });
  assert.equal(result.isError, true);
  assert.equal(text(result).error, "lease_ops_denied");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM teacher_feedback").get().n, 0);
});

test("no lease with the lease system enabled falls back to the legacy owner path", async () => {
  reset();
  assert.equal(leaseEnabled(), true);
  const task = await claimFor(OWNER);
  const result = await callReviewTool(OWNER, "complete_review_task", {
    taskId: task.id, fence: task.fence,
    feedback: "Text correction", evidence: "Text evidence",
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(
    sql.prepare("SELECT user_id FROM teacher_feedback WHERE review_task_id=?").get(task.id).user_id,
    OWNER,
  );
});

test("lease-verified renew, checkpoint, read and fail all bind the signed scope", async () => {
  reset();
  seedUser(TENANT);
  const task = await claimFor(TENANT);
  const lease = await leaseFor(task, TENANT, [
    "renew_review_lease", "save_review_checkpoint", "read_review_checkpoint", "fail_review_task",
  ]);

  const renewed = text(await callReviewTool(OWNER, "renew_review_lease", {
    taskId: task.id, fence: task.fence, lease, extendMs: 600_000,
  }));
  assert.ok(renewed.leaseUntil > Date.now());

  const saved = text(await callReviewTool(OWNER, "save_review_checkpoint", {
    taskId: task.id, fence: task.fence, lease, analysisVersion: "analysis-v1",
    stage: "read_input", chunkIndex: 0,
    inputSha256: "a".repeat(64), artifactSha256: "b".repeat(64), bytes: 12, coverage: 1,
  }));
  assert.equal(saved.saved, true);

  const read = text(await callReviewTool(OWNER, "read_review_checkpoint", {
    taskId: task.id, fence: task.fence, lease,
  }));
  assert.equal(read.checkpoint.artifactSha256, "b".repeat(64));

  const failed = text(await callReviewTool(OWNER, "fail_review_task", {
    taskId: task.id, fence: task.fence, lease, code: "runner_error", retryable: true,
  }));
  assert.equal(failed.state, "retry_wait");
});

test("atomic users predicate blocks a suspended tenant (S1.1)", async () => {
  reset();
  seedUser(TENANT, { status: "suspended" });
  const task = await claimFor(TENANT);
  const lease = await leaseFor(task, TENANT, ["complete_review_task"]);
  const result = await callReviewTool(TENANT, "complete_review_task", {
    taskId: task.id, fence: task.fence, lease,
    feedback: "Text correction", evidence: "Text evidence",
  });
  assert.equal(result.isError, true);
  assert.equal(text(result).error, "stale_lease");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM teacher_feedback").get().n, 0);
});

test("atomic users predicate rejects a stale revocation epoch (S1.1)", async () => {
  reset();
  seedUser(TENANT, { status: "active", revocationEpoch: 2 });
  const task = await claimFor(TENANT);
  const lease = await leaseFor(task, TENANT, ["complete_review_task"], { rev: 1 });
  const result = await callReviewTool(TENANT, "complete_review_task", {
    taskId: task.id, fence: task.fence, lease,
    feedback: "Text correction", evidence: "Text evidence",
  });
  assert.equal(result.isError, true);
  assert.equal(text(result).error, "stale_lease");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM teacher_feedback").get().n, 0);
});

test("service audit without a verified lease writes userId=null and taskId=null", async () => {
  reset();
  const auth = {
    user: { userId: OWNER, displayName: "", email: "", fullName: null },
    scope: "coach-runner",
    identityType: "access-jwt",
  };
  await auditServiceCall(auth, "complete_review_task", { taskId: "foreign-task", fence: 3 }, { content: [] });
  assert.equal(auditRows.length, 1, "audit row written without a task lookup");
  assert.equal(auditRows[0].userId, null);
  assert.equal(auditRows[0].taskId, null);
  assert.equal(auditRows[0].event, "mcp_service_call");

  await auditServiceCall(auth, "complete_review_task", { taskId: "foreign-task", fence: 3 }, { content: [] }, TENANT);
  assert.equal(auditRows[1].userId, TENANT, "verified uid attributes the row");
  assert.equal(auditRows[1].taskId, "foreign-task");
});

console.log("PASS lease integration tests");