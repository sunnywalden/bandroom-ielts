// Task lease tests (design rev3.1 §4.3, B1 fix).
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Mock cloudflare:workers env with a test lease key.
const TEST_KEY = "a".repeat(64);
globalThis.__leaseEnv = { BANDROOM_LEASE_KEY: TEST_KEY, BANDROOM_LEASE_KID: "test-kid" };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env=globalThis.__leaseEnv", shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { signLease, verifyLease, leaseEnabled } = await import("../lib/lease.ts");

test("leaseEnabled returns true when key is configured", () => {
  assert.equal(leaseEnabled(), true);
});

test("signLease produces a two-part token", async () => {
  const now = Date.now();
  const token = await signLease({
    tid: "task-1", uid: "user-1", fence: 1, rid: "runner-1",
    ops: ["complete_review_task"], iat: now, exp: now + 300_000, rev: 0,
  });
  assert.ok(token);
  assert.ok(token.includes("."));
  const parts = token.split(".");
  assert.equal(parts.length, 2);
});

test("verifyLease round-trips a valid lease", async () => {
  const now = Date.now();
  const token = await signLease({
    tid: "task-1", uid: "user-1", fence: 3, rid: "runner-1",
    ops: ["complete_review_task", "renew_review_lease"], iat: now, exp: now + 300_000, rev: 0,
  });
  const payload = await verifyLease(token, "complete_review_task");
  assert.equal(payload.tid, "task-1");
  assert.equal(payload.uid, "user-1");
  assert.equal(payload.fence, 3);
  assert.equal(payload.rid, "runner-1");
  assert.equal(payload.rev, 0);
  assert.equal(payload.v, 1);
  assert.equal(payload.kid, "test-kid");
});

test("verifyLease rejects missing token", async () => {
  await assert.rejects(() => verifyLease(null, "complete_review_task"), /lease_missing/);
  await assert.rejects(() => verifyLease(undefined, "complete_review_task"), /lease_missing/);
  await assert.rejects(() => verifyLease("", "complete_review_task"), /lease_missing/);
});

test("verifyLease rejects tampered payload", async () => {
  const now = Date.now();
  const token = await signLease({
    tid: "task-1", uid: "user-1", fence: 1, rid: "runner-1",
    ops: ["complete_review_task"], iat: now, exp: now + 300_000, rev: 0,
  });
  // Tamper: change uid in the payload
  const [encoded, sig] = token.split(".");
  const payload = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
  payload.uid = "victim-user";
  const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await assert.rejects(() => verifyLease(`${tampered}.${sig}`, "complete_review_task"), /lease_invalid/);
});

test("verifyLease rejects expired lease", async () => {
  const now = Date.now();
  const token = await signLease({
    tid: "task-1", uid: "user-1", fence: 1, rid: "runner-1",
    ops: ["complete_review_task"], iat: now - 600_000, exp: now - 1, rev: 0,
  });
  await assert.rejects(() => verifyLease(token, "complete_review_task"), /lease_expired/);
});

test("verifyLease rejects wrong operation", async () => {
  const now = Date.now();
  const token = await signLease({
    tid: "task-1", uid: "user-1", fence: 1, rid: "runner-1",
    ops: ["renew_review_lease"], iat: now, exp: now + 300_000, rev: 0,
  });
  await assert.rejects(() => verifyLease(token, "complete_review_task"), /lease_ops_denied/);
});

test("verifyLease rejects wrong kid", async () => {
  const now = Date.now();
  const token = await signLease({
    tid: "task-1", uid: "user-1", fence: 1, rid: "runner-1",
    ops: ["complete_review_task"], iat: now, exp: now + 300_000, rev: 0,
  });
  // Change the kid
  globalThis.__leaseEnv.BANDROOM_LEASE_KID = "rotated-kid";
  await assert.rejects(() => verifyLease(token, "complete_review_task"), /lease_invalid/);
  globalThis.__leaseEnv.BANDROOM_LEASE_KID = "test-kid";
});

test("verifyLease rejects garbage token", async () => {
  await assert.rejects(() => verifyLease("not-a-lease", "complete_review_task"), /lease_invalid/);
  await assert.rejects(() => verifyLease("abc.def", "complete_review_task"), /lease_invalid/);
});

test("signLease returns null when key is absent", async () => {
  const saved = globalThis.__leaseEnv.BANDROOM_LEASE_KEY;
  delete globalThis.__leaseEnv.BANDROOM_LEASE_KEY;
  const now = Date.now();
  const token = await signLease({
    tid: "t", uid: "u", fence: 1, rid: "r",
    ops: ["complete_review_task"], iat: now, exp: now + 300_000, rev: 0,
  });
  assert.equal(token, null);
  assert.equal(leaseEnabled(), false);
  globalThis.__leaseEnv.BANDROOM_LEASE_KEY = saved;
});

console.log("PASS lease tests");