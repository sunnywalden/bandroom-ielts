// MT-3 consent gate (design rev3.1 §4.7, B4/S8.1): server-side voice consent.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) {
  sql.exec(readFileSync("drizzle/" + file, "utf8"));
}
function statement(query, args = []) {
  return {
    bind: (...values) => statement(query, [...args, ...values]),
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async raw() { return sql.prepare(query).all(...args).map(r => Object.values(r)); },
    async run() { const r = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  };
}
const d1 = {
  prepare: q => statement(q),
  async batch(stmts) { sql.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.run()); sql.exec("COMMIT"); return out; } catch (e) { sql.exec("ROLLBACK"); throw e; } },
};
globalThis.__consentEnv = { DB: d1, BANDROOM_OWNER_USER_ID: "owner-1", BANDROOM_CONSENT_GATE: "on" };
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export const env=globalThis.__consentEnv", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: new URL("../" + spec.slice(2) + ".ts", import.meta.url).href, shortCircuit: true };
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[a-z]+$/i.test(spec) && ctx.parentURL?.endsWith(".ts"))
      return { url: new URL(spec + ".ts", ctx.parentURL).href, shortCircuit: true };
    return next(spec, ctx);
  },
});
const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");
const db = drizzle(d1, { schema });
const consent = await import("../lib/consent.ts");

function seedUser(userId, status = "active") {
  const now = Date.now();
  sql.prepare(`INSERT INTO users (user_id,idp_iss,idp_sub,email_normalized,role,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status`)
    .run(userId, "iss", "sub-" + userId, userId + "@example.com", "learner", status, now, now);
}
function seedTask(userId, state = "queued") {
  const id = "task-" + Math.random().toString(36).slice(2);
  const now = Date.now();
  sql.prepare(`INSERT INTO review_tasks (id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,next_at,created_at,updated_at)
    VALUES (?,?,?,'speaking',?,12,1,'read_input',?,?,?,?)`)
    .run(id, "job-" + id, userId, "att-" + id, state, now, now, now);
  return id;
}

test("no consent -> invalid; assertConsent throws 403", async () => {
  seedUser("learner-a");
  assert.equal(await consent.hasValidConsent(db, "learner-a"), false);
  await assert.rejects(() => consent.assertConsent(db, "learner-a"),
    e => e instanceof consent.ConsentError && e.status === 403 && e.code === "consent_required");
});

test("recordConsent grants current version and updates snapshot", async () => {
  seedUser("learner-b");
  const res = await consent.recordConsent(db, "learner-b", consent.requiredConsentVersion());
  assert.equal(res.recorded, true);
  assert.equal(await consent.hasValidConsent(db, "learner-b"), true);
  const row = sql.prepare("SELECT consent_version, consent_at FROM users WHERE user_id='learner-b'").get();
  assert.equal(row.consent_version, consent.requiredConsentVersion());
  assert.ok(row.consent_at > 0);
  const events = sql.prepare("SELECT * FROM consent_events WHERE user_id='learner-b'").all();
  assert.equal(events.length, 1);
});

test("stale version is not valid (re-consent required)", async () => {
  seedUser("learner-c");
  await consent.recordConsent(db, "learner-c", "voice-processing-v0");
  assert.equal(await consent.hasValidConsent(db, "learner-c"), false);
});

test("withdrawConsent clears snapshot, marks events, blocks non-terminal tasks", async () => {
  seedUser("learner-d");
  await consent.recordConsent(db, "learner-d", consent.requiredConsentVersion());
  const queued = seedTask("learner-d", "queued");
  const running = seedTask("learner-d", "running");
  assert.equal(await consent.hasValidConsent(db, "learner-d"), true);
  const res = await consent.withdrawConsent(db, "learner-d");
  assert.equal(res.withdrawn, true);
  assert.equal(await consent.hasValidConsent(db, "learner-d"), false);
  const row = sql.prepare("SELECT consent_version, consent_at FROM users WHERE user_id='learner-d'").get();
  assert.equal(row.consent_version, null);
  assert.equal(sql.prepare("SELECT state FROM review_tasks WHERE id=?").get(queued).state, "blocked");
  assert.equal(sql.prepare("SELECT state FROM review_tasks WHERE id=?").get(running).state, "blocked");
  const ev = sql.prepare("SELECT withdrawn_at FROM consent_events WHERE user_id='learner-d'").get();
  assert.ok(ev.withdrawn_at > 0);
});

test("owner is exempt transitionally (F10)", async () => {
  seedUser("owner-1");
  // No explicit consent record, but the env owner is exempt.
  assert.equal(await consent.hasValidConsent(db, "owner-1"), true);
});

test("suspended/revoked tenants are not consented even with a grant", async () => {
  seedUser("learner-e");
  await consent.recordConsent(db, "learner-e", consent.requiredConsentVersion());
  assert.equal(await consent.hasValidConsent(db, "learner-e"), true);
  seedUser("learner-e", "suspended");
  assert.equal(await consent.hasValidConsent(db, "learner-e"), false);
});

test("gate fails closed: default enforced; only explicit off disables (security review)", async () => {
  seedUser("learner-f");
  delete globalThis.__consentEnv.BANDROOM_CONSENT_GATE; // default = enforced
  assert.equal(await consent.hasValidConsent(db, "learner-f"), false, "missing flag must NOT allow voice");
  globalThis.__consentEnv.BANDROOM_CONSENT_GATE = "on";
  assert.equal(await consent.hasValidConsent(db, "learner-f"), false);
  globalThis.__consentEnv.BANDROOM_CONSENT_GATE = "off"; // explicit fixture opt-out
  assert.equal(await consent.hasValidConsent(db, "learner-f"), true);
  globalThis.__consentEnv.BANDROOM_CONSENT_GATE = "on"; // restore for other tests
});

test("recordConsent refuses non-active tenants", async () => {
  seedUser("learner-g", "pending");
  const res = await consent.recordConsent(db, "learner-g", consent.requiredConsentVersion());
  assert.equal(res.recorded, false);
});

console.log("PASS consent tests");