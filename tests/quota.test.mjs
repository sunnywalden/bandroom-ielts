// MT-4 quotas + rate limits (design rev3.1 §4.5, B6/S12).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) {
  sql.exec(readFileSync("drizzle/" + file, "utf8"));
}
const d1 = {
  prepare(query) {
    return {
      bind(...args) {
        return {
          async first() { return sql.prepare(query).get(...args) ?? null; },
          async run() { const r = sql.prepare(query).run(...args); return { meta: { changes: Number(r.changes) } }; },
        };
      },
    };
  },
};
const quota = await import("../lib/quota.ts");

test("submission quota increments and caps at the daily limit", async () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  for (let i = 0; i < quota.DEFAULT_QUOTAS.submissionsPerDay; i++) {
    await quota.checkSubmissionQuota(d1, "user-a", now);
  }
  await assert.rejects(() => quota.checkSubmissionQuota(d1, "user-a", now),
    e => e instanceof quota.QuotaError && e.status === 429 && e.retryAfter > 0);
  // Another tenant is unaffected.
  await quota.checkSubmissionQuota(d1, "user-b", now);
});

test("audio quota caps daily bytes; next UTC day resets", async () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const cap = quota.DEFAULT_QUOTAS.audioBytesPerDay;
  await quota.checkAudioQuota(d1, "user-c", cap - 1000, now);
  await assert.rejects(() => quota.checkAudioQuota(d1, "user-c", 2000, now),
    e => e instanceof quota.QuotaError);
  // Next day resets the counter.
  const nextDay = now + 86_400_000;
  await quota.checkAudioQuota(d1, "user-c", 2000, nextDay);
});

test("queue depth guard refuses when too many pending tasks", async () => {
  const now = Date.now();
  for (let i = 0; i < quota.DEFAULT_QUOTAS.queueDepth; i++) {
    const id = "q-" + i;
    sql.prepare(`INSERT INTO review_tasks (id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,next_at,created_at,updated_at)
      VALUES (?,?,?,'text',?,12,1,'read_input','queued',?,?,?)`)
      .run(id, "job-" + id, "user-d", "att-" + id, now, now, now);
  }
  await assert.rejects(() => quota.checkQueueDepth(d1, "user-d"), e => e instanceof quota.QuotaError);
  await quota.checkQueueDepth(d1, "user-empty"); // no tasks -> ok
});

test("rateLimit fixed window allows up to limit then blocks; resets next window", async () => {
  const windowMs = 60_000;
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(await quota.rateLimit(d1, "ip:1.2.3.4", 5, windowMs, t0 + i), true);
  assert.equal(await quota.rateLimit(d1, "ip:1.2.3.4", 5, windowMs, t0 + 10), false);
  // Next window resets.
  assert.equal(await quota.rateLimit(d1, "ip:1.2.3.4", 5, windowMs, t0 + windowMs + 1), true);
  // Different key independent.
  assert.equal(await quota.rateLimit(d1, "ip:5.6.7.8", 5, windowMs, t0 + 10), true);
});

test("quotaResponse carries 429 + Retry-After", async () => {
  const res = quota.quotaResponse(new quota.QuotaError("cap", 123));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "123");
  const body = await res.json();
  assert.equal(body.error, "quota_exceeded");
  assert.equal(body.retryAfter, 123);
});

test("model call quota caps", async () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  for (let i = 0; i < quota.DEFAULT_QUOTAS.modelCallsPerDay; i++) await quota.recordModelCall(d1, "user-e", now);
  await assert.rejects(() => quota.recordModelCall(d1, "user-e", now), e => e instanceof quota.QuotaError);
});

console.log("PASS quota tests");