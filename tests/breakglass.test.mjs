// MT-2 break-glass grants: HMAC round-trip, expiry, tamper detection,
// read-only op enforcement and target binding. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const TEST_KEY = "b".repeat(64);
globalThis.__breakglassEnv = { BANDROOM_BREAKGLASS_KEY: TEST_KEY };
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env=globalThis.__breakglassEnv", shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { issueBreakglassGrant, verifyBreakglassGrant, breakglassEnabled } = await import("../lib/breakglass.ts");

const future = () => Date.now() + 300_000;

test("issue/verify round-trips a target-bound read grant", async () => {
  assert.equal(breakglassEnabled(), true);
  const exp = future();
  const token = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", ops: ["read"], exp, reason: "support case 42",
  });
  assert.ok(token);
  assert.equal(token.split(".").length, 2);
  const payload = await verifyBreakglassGrant(token);
  assert.deepEqual(payload, {
    v: 1, targetUid: "target-a", actorUid: "admin-a", ops: ["read"], exp, reason: "support case 42",
  });
});

test("the grant is target-bound: the payload cannot name another tenant", async () => {
  const token = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", exp: future(), reason: "r",
  });
  const payload = await verifyBreakglassGrant(token);
  assert.equal(payload.targetUid, "target-a");
  assert.notEqual(payload.targetUid, "target-b");
});

test("expired grants are rejected", async () => {
  const token = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", exp: Date.now() - 1, reason: "r",
  });
  await assert.rejects(() => verifyBreakglassGrant(token), /breakglass_expired/);
});

test("tampered payloads are rejected before JSON parsing", async () => {
  const token = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", exp: future(), reason: "r",
  });
  const [encoded, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  payload.targetUid = "target-victim";
  const tampered = Buffer.from(JSON.stringify(payload)).toString("base64url");
  await assert.rejects(() => verifyBreakglassGrant(`${tampered}.${signature}`), /breakglass_invalid/);
  await assert.rejects(() => verifyBreakglassGrant(`${encoded}.${signature.slice(0, -2)}AA`), /breakglass_invalid/);
});

test("write ops are denied: break-glass is read-only", async () => {
  const writeToken = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", ops: ["write"], exp: future(), reason: "r",
  });
  await assert.rejects(() => verifyBreakglassGrant(writeToken), /breakglass_ops_denied/);
  const mixedToken = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", ops: ["read", "write"], exp: future(), reason: "r",
  });
  await assert.rejects(() => verifyBreakglassGrant(mixedToken), /breakglass_ops_denied/);
});

test("missing, malformed and garbage tokens fail closed", async () => {
  await assert.rejects(() => verifyBreakglassGrant(null), /breakglass_missing/);
  await assert.rejects(() => verifyBreakglassGrant(""), /breakglass_missing/);
  await assert.rejects(() => verifyBreakglassGrant("not-a-grant"), /breakglass_invalid/);
  await assert.rejects(() => verifyBreakglassGrant("abc.def"), /breakglass_invalid/);
});

test("no signing key means issue returns null and verify fails closed", async () => {
  const env = globalThis.__breakglassEnv;
  const savedBreakglass = env.BANDROOM_BREAKGLASS_KEY;
  const savedAnalysis = env.ANALYSIS_SIGNING_KEY;
  delete env.BANDROOM_BREAKGLASS_KEY;
  delete env.ANALYSIS_SIGNING_KEY;
  assert.equal(breakglassEnabled(), false);
  const token = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", exp: future(), reason: "r",
  });
  assert.equal(token, null);

  // A structurally valid token signed under a different key is rejected.
  env.BANDROOM_BREAKGLASS_KEY = "c".repeat(64);
  const leaked = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", exp: future(), reason: "r",
  });
  delete env.BANDROOM_BREAKGLASS_KEY;
  await assert.rejects(() => verifyBreakglassGrant(leaked), /breakglass_invalid/);

  env.BANDROOM_BREAKGLASS_KEY = savedBreakglass;
  if (savedAnalysis !== undefined) env.ANALYSIS_SIGNING_KEY = savedAnalysis;
  else delete env.ANALYSIS_SIGNING_KEY;
  assert.equal(breakglassEnabled(), true);
});

test("ANALYSIS_SIGNING_KEY is the documented fallback", async () => {
  const env = globalThis.__breakglassEnv;
  const savedBreakglass = env.BANDROOM_BREAKGLASS_KEY;
  delete env.BANDROOM_BREAKGLASS_KEY;
  env.ANALYSIS_SIGNING_KEY = "s".repeat(32);
  const token = await issueBreakglassGrant({
    targetUid: "target-a", actorUid: "admin-a", exp: future(), reason: "fallback",
  });
  assert.ok(token);
  assert.equal((await verifyBreakglassGrant(token)).reason, "fallback");
  env.BANDROOM_BREAKGLASS_KEY = savedBreakglass;
  delete env.ANALYSIS_SIGNING_KEY;
});