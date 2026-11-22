// MT-2 admin operations against real SQLite (node:sqlite) + Drizzle D1 driver.
// Covers lifecycle approval/suspension/revocation, epoch/lease invalidation,
// tombstoned PII, content-blind aggregates, invites, and the audit trail.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { createHash, randomUUID } from "node:crypto";

registerHooks({
  resolve(specifier, context, next) {
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

const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) {
  sql.exec(readFileSync("drizzle/" + file, "utf8"));
}

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
  };
}
const d1 = {
  prepare: query => statement(query),
  async batch(statements) {
    sql.exec("BEGIN");
    try {
      const results = [];
      for (const entry of statements) results.push(await entry.run());
      sql.exec("COMMIT");
      return results;
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  },
};

const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");
const db = drizzle(d1, { schema });
const admin = await import("../lib/admin.ts");

const row = (query, ...args) => {
  const value = sql.prepare(query).get(...args);
  return value ? { ...value } : null;
};
const sha256 = value => createHash("sha256").update(value).digest("hex");

function insertUser({
  userId = "user-" + randomUUID(),
  email,
  role = "learner",
  status = "pending",
  displayName = null,
  now = 1_700_000_000_000,
} = {}) {
  const normalizedEmail = (email ?? `${userId}@example.com`).toLowerCase();
  sql.prepare(`INSERT INTO users
    (user_id,idp_iss,idp_sub,email_normalized,display_name,role,status,consent_version,revocation_epoch,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?)`)
    .run(userId, "https://idp.example", "sub-" + userId, normalizedEmail, displayName, role, status, "v1", now, now);
  return userId;
}

function insertTask({ userId, state = "running", leaseUntil = 9_999_999_999_999 } = {}) {
  const id = randomUUID();
  const now = 1_700_000_000_000;
  sql.prepare(`INSERT INTO review_tasks
    (id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,lease_until,next_at,created_at,updated_at)
    VALUES (?,?,?,'text',?,12,22,'read_input',?,?,?,?,?)`)
    .run(id, "job-" + id, userId, "attempt-" + id, state, leaseUntil, now, now, now);
  return id;
}

function audits(action) {
  return sql.prepare("SELECT actor_user_id, target_user_id, reason, expires_at FROM admin_audit WHERE action=? ORDER BY id").all(action)
    .map(entry => ({ ...entry }));
}

test("approveUser moves pending -> active and writes an audit row", async () => {
  const userId = insertUser({ status: "pending" });
  assert.deepEqual(await admin.approveUser(db, "admin-1", userId), { approved: true });
  assert.equal(row("SELECT status FROM users WHERE user_id=?", userId).status, "active");
  const entries = audits("approve");
  assert.equal(entries.at(-1).actor_user_id, "admin-1");
  assert.equal(entries.at(-1).target_user_id, userId);
  // Idempotent refusal: an already-active tenant is not re-approved.
  assert.deepEqual(await admin.approveUser(db, "admin-1", userId), { approved: false });
});

test("suspendUser bumps the epoch and invalidates running leases", async () => {
  const userId = insertUser({ status: "active" });
  const running = insertTask({ userId, state: "running" });
  const queued = insertTask({ userId, state: "queued", leaseUntil: null });

  assert.deepEqual(await admin.suspendUser(db, "admin-1", userId, "policy"), { suspended: true });
  const user = row("SELECT status, revocation_epoch FROM users WHERE user_id=?", userId);
  assert.equal(user.status, "suspended");
  assert.equal(user.revocation_epoch, 1);
  const blocked = row("SELECT state, lease_until FROM review_tasks WHERE id=?", running);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.lease_until, null);
  assert.equal(row("SELECT state FROM review_tasks WHERE id=?", queued).state, "queued", "only running tasks are blocked");
  assert.deepEqual(audits("suspend").at(-1), {
    actor_user_id: "admin-1", target_user_id: userId, reason: "policy", expires_at: null,
  });
});

test("revokeUser tombstones PII but keeps the identity key", async () => {
  const userId = insertUser({ status: "suspended", email: "bob@example.com", displayName: "Bob" });
  assert.deepEqual(await admin.revokeUser(db, "admin-1", userId, "dsr"), { revoked: true });
  const user = row("SELECT status, email_normalized, display_name, revoked_at, revocation_epoch, idp_iss, idp_sub FROM users WHERE user_id=?", userId);
  assert.equal(user.status, "revoked");
  assert.equal(user.email_normalized, null, "email PII cleared");
  assert.equal(user.display_name, null, "display name cleared");
  assert.ok(user.revoked_at, "revoked_at stamped");
  assert.equal(user.revocation_epoch, 1);
  assert.equal(user.idp_iss, "https://idp.example");
  assert.equal(user.idp_sub, "sub-" + userId);
  assert.equal(audits("revoke").at(-1).reason, "dsr");
});

test("listUsers masks email and projects no learner content", async () => {
  const secret = "SECRET-LEARNER-CONTENT";
  const userId = insertUser({ status: "active", email: "carol@example.com", now: 1_700_000_000_001 });
  sql.prepare("INSERT INTO learner_states(user_id,revision,state) VALUES (?,?,?)")
    .run(userId, 3, JSON.stringify({ day: 12, secret }));
  sql.prepare(`INSERT INTO teacher_feedback(id,user_id,day,stage,attempt,evidence,feedback,author_scope,created_at)
    VALUES (?,?,12,'write','a',?,?, 'coach', 'now')`).run("fb-" + userId, userId, secret, secret);

  const users = await admin.listUsers(db, { status: "active" });
  const listed = users.find(entry => entry.userId === userId);
  assert.equal(listed.emailNormalized, "c***@example.com");
  assert.deepEqual(Object.keys(listed).sort(),
    ["consentVersion", "createdAt", "emailNormalized", "role", "status", "updatedAt", "userId"]);
  assert.ok(!JSON.stringify(users).includes(secret), "no learner content leaked");
  assert.ok((await admin.listUsers(db)).length >= users.length, "unfiltered list includes active tenants");
});

test("cost and queue aggregates contain counts only", async () => {
  const secret = "ANSWER-TEXT-MUST-NOT-APPEAR";
  const userId = insertUser({ status: "active" });
  sql.prepare("INSERT INTO user_cost_ledger(user_id,utc_day,spent_micro_cny,paused,updated_at) VALUES (?,?,?,0,?)")
    .run(userId, "2026-11-20", 1500, 1);
  sql.prepare("INSERT INTO learner_states(user_id,revision,state) VALUES (?,1,?)")
    .run(userId, JSON.stringify({ secret }));

  const cost = await admin.costAggregate(db, "2026-11-20");
  assert.deepEqual(cost.find(entry => entry.userId === userId), { userId, spentMicroCny: 1500 });
  assert.deepEqual(Object.keys(cost[0]).sort(), ["spentMicroCny", "userId"]);

  const queue = await admin.queueStats(db);
  assert.deepEqual(Object.keys(queue[0]).sort(), ["count", "state", "userId"]);
  assert.ok(!JSON.stringify({ cost, queue }).includes(secret), "aggregates never carry content");
});

test("queueStats groups by user and state", async () => {
  const userId = insertUser({ status: "active" });
  insertTask({ userId, state: "running" });
  insertTask({ userId, state: "queued", leaseUntil: null });
  insertTask({ userId, state: "queued", leaseUntil: null });
  const entries = (await admin.queueStats(db)).filter(entry => entry.userId === userId);
  assert.deepEqual(
    entries.sort((a, b) => a.state.localeCompare(b.state)),
    [{ userId, state: "queued", count: 2 }, { userId, state: "running", count: 1 }],
  );
});

test("invite create stores only a hash and returns the plaintext once", async () => {
  const created = await admin.createInvite(db, "admin-1", { email: "dave@example.com", ttlMs: 60_000 });
  assert.ok(created.code.startsWith("brinv_"));
  const stored = row("SELECT id, code_hash, email, role, expires_at, used_at FROM invites WHERE id=?", created.id);
  assert.equal(stored.code_hash, sha256(created.code));
  assert.notEqual(stored.code_hash, created.code);
  assert.equal(stored.email, "dave@example.com");
  assert.equal(stored.role, "learner");
  assert.equal(stored.expires_at, created.expiresAt);
  const entries = audits("invite_create");
  assert.equal(entries.at(-1).actor_user_id, "admin-1");
  assert.ok(!JSON.stringify(entries).includes(created.code), "plaintext code never audited");
});

test("redeemInvite activates a matching pending tenant exactly once", async () => {
  const userId = insertUser({ status: "pending", email: "erin@example.com" });
  const { code } = await admin.createInvite(db, "admin-1", { email: "erin@example.com", ttlMs: 60_000 });
  assert.deepEqual(await admin.redeemInvite(db, code, userId), { redeemed: true });
  assert.equal(row("SELECT status FROM users WHERE user_id=?", userId).status, "active");
  const used = row("SELECT used_at, used_by FROM invites WHERE code_hash=?", sha256(code));
  assert.ok(used.used_at);
  assert.equal(used.used_by, userId);
  assert.deepEqual(await admin.redeemInvite(db, code, userId), { redeemed: false }, "single-use");
});

test("redeemInvite refuses expired, email-mismatched and revoked tenants", async () => {
  const expiredUser = insertUser({ status: "pending", email: "frank@example.com" });
  const expiredInvite = await admin.createInvite(db, "admin-1", { ttlMs: 60_000 });
  sql.prepare("UPDATE invites SET expires_at=? WHERE id=?").run(Date.now() - 1, expiredInvite.id);
  assert.deepEqual(await admin.redeemInvite(db, expiredInvite.code, expiredUser), { redeemed: false });

  const mismatchUser = insertUser({ status: "pending", email: "grace@example.com" });
  const mismatch = await admin.createInvite(db, "admin-1", { email: "someone@example.com", ttlMs: 60_000 });
  assert.deepEqual(await admin.redeemInvite(db, mismatch.code, mismatchUser), { redeemed: false });

  const revokedUser = insertUser({ status: "revoked", email: "henry@example.com" });
  const openInvite = await admin.createInvite(db, "admin-1", { ttlMs: 60_000 });
  assert.deepEqual(await admin.redeemInvite(db, openInvite.code, revokedUser), { redeemed: false },
    "a revoked tombstone is never resurrected");
  assert.equal(row("SELECT status FROM users WHERE user_id=?", revokedUser).status, "revoked");
});

test("redeemInvite refuses a suspended tenant (security review: no resurrection)", async () => {
  const userId = insertUser({ status: "suspended", email: "susp@example.com" });
  const { code } = await admin.createInvite(db, "admin-1", { email: "susp@example.com", ttlMs: 60_000 });
  assert.deepEqual(await admin.redeemInvite(db, code, userId), { redeemed: false });
  assert.equal(row("SELECT status FROM users WHERE user_id=?", userId).status, "suspended",
    "suspended tenant is not re-activated by an invite");
});

test("suspendUser and revokeUser kill the tenant's PATs immediately (security review)", async () => {
  const { createPat, resolvePat } = await import("../lib/pat.ts");
  const userId = insertUser({ status: "active", email: "pat@example.com" });
  const pat = await createPat(db, userId);
  assert.deepEqual(await resolvePat(db, pat.token), { userId });
  await admin.suspendUser(db, "admin-1", userId, "policy");
  assert.equal(await resolvePat(db, pat.token), null, "suspend revokes PATs");
  assert.ok(row("SELECT revoked_at FROM user_tokens WHERE id=?", pat.id).revoked_at > 0);

  const userId2 = insertUser({ status: "active", email: "pat2@example.com" });
  const pat2 = await createPat(db, userId2);
  await admin.revokeUser(db, "admin-1", userId2, "delete");
  assert.equal(await resolvePat(db, pat2.token), null, "revoke revokes PATs");
});

test("logAdminAudit appends the documented fields", async () => {
  await admin.logAdminAudit(db, {
    actorUserId: "admin-9",
    action: "manual_note",
    targetUserId: "target-9",
    reason: "audit",
    expiresAt: 123,
    metadata: { key: "value" },
  });
  const entry = row("SELECT actor_user_id, action, target_user_id, reason, expires_at, metadata_json FROM admin_audit WHERE action='manual_note'");
  assert.deepEqual(entry, {
    actor_user_id: "admin-9",
    action: "manual_note",
    target_user_id: "target-9",
    reason: "audit",
    expires_at: 123,
    metadata_json: JSON.stringify({ key: "value" }),
  });
});