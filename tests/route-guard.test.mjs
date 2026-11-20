// Route guard behavior: owner-only browser routes, service identity rejection,
// read-only mirror writes and canonical origin enforcement. No network.
import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {pathToFileURL} from "node:url";

const root = pathToFileURL(process.cwd() + "/");
const mock = source => ({url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true});
globalThis.__guardEnv = {};
globalThis.__guardCtx = {user: null, scope: null, identityType: null};
const guardEnv = globalThis.__guardEnv;
function setEnv(values = {}) {
  for (const key of Object.keys(guardEnv)) delete guardEnv[key];
  Object.assign(guardEnv, values);
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return mock("export const env=globalThis.__guardEnv");
    if (specifier === "@/app/chatgpt-auth") return mock(
      "export const getAuthContext=async()=>globalThis.__guardCtx;"
      + "export const getChatGPTUser=async()=>globalThis.__guardCtx.user",
    );
    if (specifier.startsWith("@/")) return {url: new URL(specifier.slice(2) + ".ts", root).href, shortCircuit: true};
    return next(specifier, context);
  },
});
const {requireOwnerScope, evaluateOwnerScope, evaluateUserScope, requireUserScope, requireAdminScope, evaluateAdminScope, evaluateBreakglassScope, isCanonicalOrigin} = await import("../lib/route-guard.ts");

const ownerUser = {userId: "owner-1", displayName: "Owner", email: "owner@example.com", fullName: null};
const owner = {user: ownerUser, scope: "owner", identityType: "access-jwt"};
const learnerUser = {userId: "learner-1", displayName: "Learner", email: "l@example.com", fullName: null};
const learner = {user: learnerUser, scope: "learner", identityType: "access-jwt"};

test("tenant guard accepts a learner scoped to its own userId", async () => {
  globalThis.__guardCtx = learner;
  setEnv();
  assert.deepEqual(await requireUserScope(), {user: learnerUser});
  assert.deepEqual(await requireUserScope({write: true}), {user: learnerUser});
});

test("learner is rejected by the strict owner gate (no privilege escalation)", () => {
  const denied = evaluateOwnerScope(learner);
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 403);
  assert.deepEqual(evaluateUserScope(learner), {user: learnerUser});
});

test("tenant guard rejects service and anonymous identities", () => {
  for (const scope of ["coach", "coach-runner"]) {
    const r = evaluateUserScope({user: ownerUser, scope, identityType: "access-jwt"});
    assert.ok(r instanceof Response, scope);
    assert.equal(r.status, 403, scope);
  }
  const anon = evaluateUserScope({user: null, scope: null, identityType: null});
  assert.ok(anon instanceof Response);
  assert.equal(anon.status, 401);
});

test("owner scope is accepted for reads and writes", async () => {
  globalThis.__guardCtx = owner;
  setEnv();
  assert.deepEqual(await requireOwnerScope(), {user: ownerUser});
  assert.deepEqual(await requireOwnerScope({write: true}), {user: ownerUser});
});

test("anonymous callers receive 401", async () => {
  globalThis.__guardCtx = {user: null, scope: null, identityType: null};
  const result = await requireOwnerScope();
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
  assert.deepEqual(await result.json(), {error: "sign_in_required"});
});

test("service identities (coach and coach-runner) are rejected with 403", async () => {
  for (const scope of ["coach", "coach-runner"]) {
    globalThis.__guardCtx = {user: ownerUser, scope, identityType: "access-jwt"};
    const result = await requireOwnerScope();
    assert.ok(result instanceof Response, scope);
    assert.equal(result.status, 403, scope);
    assert.deepEqual(await result.json(), {error: "owner_scope_required"});
  }
});

test("an unknown scope never becomes owner", async () => {
  const result = evaluateOwnerScope({user: ownerUser, scope: null, identityType: "access-jwt"});
  assert.ok(result instanceof Response);
  assert.equal(result.status, 403);
});

test("read-only mirror rejects writes but keeps reads available", async () => {
  globalThis.__guardCtx = owner;
  setEnv({BANDROOM_READONLY: "1"});
  const read = await requireOwnerScope();
  assert.deepEqual(read, {user: ownerUser});
  const write = await requireOwnerScope({write: true});
  assert.ok(write instanceof Response);
  assert.equal(write.status, 403);
  assert.deepEqual(await write.json(), {error: "read_only"});
  setEnv();
});

test("admin scope: owner/admin accepted, learner/service rejected (MT-2)", async () => {
  setEnv();
  for (const scope of ["owner", "admin"]) {
    globalThis.__guardCtx = {user: ownerUser, scope, identityType: "access-jwt"};
    assert.deepEqual(await requireAdminScope(), {user: ownerUser}, scope);
  }
  for (const scope of ["learner", "coach", "coach-runner", "breakglass"]) {
    globalThis.__guardCtx = {user: ownerUser, scope, identityType: "access-jwt"};
    const result = await requireAdminScope();
    assert.ok(result instanceof Response, scope);
    assert.equal(result.status, 403, scope);
  }
});

test("admin writes honour read-only mirror mode (security review)", async () => {
  globalThis.__guardCtx = {user: ownerUser, scope: "admin", identityType: "access-jwt"};
  setEnv({BANDROOM_READONLY: "1"});
  const read = await requireAdminScope();
  assert.deepEqual(read, {user: ownerUser});
  const write = await requireAdminScope({write: true});
  assert.ok(write instanceof Response);
  assert.equal(write.status, 403);
  assert.deepEqual(await write.json(), {error: "read_only"});
  setEnv();
});

test("breakglass scope is read-only and distinct (S10.1)", async () => {
  setEnv();
  globalThis.__guardCtx = {user: ownerUser, scope: "breakglass", identityType: "access-jwt"};
  assert.deepEqual(evaluateBreakglassScope(globalThis.__guardCtx), {user: ownerUser});
  const write = evaluateBreakglassScope(globalThis.__guardCtx, {write: true});
  assert.ok(write instanceof Response);
  assert.equal(write.status, 403);
  assert.deepEqual(await write.json(), {error: "breakglass_read_only"});
  // A non-breakglass scope cannot use the breakglass guard.
  const wrong = evaluateBreakglassScope({user: ownerUser, scope: "admin", identityType: "access-jwt"});
  assert.ok(wrong instanceof Response);
  assert.equal(wrong.status, 403);
});

test("canonical origin accepts only the configured host", () => {
  setEnv({BANDROOM_PUBLIC_ORIGIN: "https://study.example"});
  assert.equal(isCanonicalOrigin(new Request("https://study.example/api/review-transfer")), true);
  assert.equal(isCanonicalOrigin(new Request("https://study.example/api/review-transfer", {
    headers: {host: "study.example"},
  })), true);
  assert.equal(isCanonicalOrigin(new Request("https://study.example/api/review-transfer", {
    headers: {host: "evil.workers.dev"},
  })), false, "host swap rejected");
  assert.equal(isCanonicalOrigin(new Request("https://evil.workers.dev/api/review-transfer")), false);
  assert.equal(isCanonicalOrigin(new Request("http://study.example/api/review-transfer")), false, "protocol mismatch");
  assert.equal(isCanonicalOrigin(new Request("https://other.example/api/review-transfer")), false);
  setEnv();
  assert.equal(isCanonicalOrigin(new Request("https://study.example/api/review-transfer")), false, "missing config fails closed");
});