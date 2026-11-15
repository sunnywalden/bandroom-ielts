// Security matrix (design rev2 §6): authentication edge cases, service
// identity rejection on browser routes, read-only mirror writes, MCP scope
// enforcement and canonical-origin grant binding. No network calls.
import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {pathToFileURL} from "node:url";

const root = pathToFileURL(process.cwd() + "/");
const mock = source => ({url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true});
globalThis.__secEnv = {};
const secEnv = globalThis.__secEnv;
function setEnv(values = {}) {
  for (const key of Object.keys(secEnv)) delete secEnv[key];
  Object.assign(secEnv, values);
}
globalThis.__secCtx = {user: null, scope: null, identityType: null};
globalThis.__secHeaders = {};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return mock("export const env=globalThis.__secEnv");
    if (specifier === "next/headers") return mock("export async function headers(){return new Headers(globalThis.__secHeaders)}");
    if (specifier === "@/app/chatgpt-auth") return mock(
      "export const getAuthContext=async()=>globalThis.__secCtx;"
      + "export const getChatGPTUser=async()=>globalThis.__secCtx.user",
    );
    if (specifier === "@/db") return mock("export function getDb(){throw new Error('db_must_not_be_reached')}");
    if (specifier.startsWith("@/")) return {url: new URL(specifier.slice(2) + ".ts", root).href, shortCircuit: true};
    if ((specifier.startsWith("./") || specifier.startsWith("../"))
      && !specifier.endsWith(".ts") && context.parentURL?.startsWith(root.href)
      && !context.parentURL.includes("node_modules")) {
      return {url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
});

const {resolveAuthContext} = await import("../lib/auth-adapter.ts");
const state = await import("../app/api/state/route.ts");
const audio = await import("../app/api/audio/route.ts");
const coach = await import("../app/api/coach/route.ts");
const takeover = await import("../app/api/review-tasks/takeover/route.ts");
const backup = await import("../app/api/backup/route.ts");
const transfer = await import("../app/api/review-transfer/route.ts");
const bundle = await import("../app/api/analysis-bundle/route.ts");
const mcp = await import("../app/mcp/route.ts");

const origin = "https://study.example";
const ownerUser = {userId: "owner-user-id", displayName: "Owner", email: "owner@example.com", fullName: null};
const owner = {user: ownerUser, scope: "owner", identityType: "access-jwt"};
const anonymous = {user: null, scope: null, identityType: null};
const service = scope => ({user: ownerUser, scope, identityType: "access-jwt"});
const sameOrigin = (path, init = {}) => new Request(origin + path, {
  ...init,
  headers: {origin, ...(init.headers ?? {})},
});
const jsonBody = (path, body) => sameOrigin(path, {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
});

// --- auth edge cases -------------------------------------------------------
const NOW = 1_800_000_000_000;
const encoder = new TextEncoder();
const b64url = value => Buffer.from(value).toString("base64url");
async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    {name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"},
    true, ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {pair, jwk: {...jwk, kid, alg: "RS256", use: "sig"}};
}
async function signToken(key, kid, claims) {
  const head = b64url(encoder.encode(JSON.stringify({alg: "RS256", kid, typ: "JWT"})));
  const body = b64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, encoder.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}
const key = await makeKey("matrix-kid");
const otherKey = await makeKey("matrix-other");
const jwksFetcher = () => async () => new Response(JSON.stringify({keys: [key.jwk]}), {
  status: 200, headers: {"content-type": "application/json"},
});
function matrixEnv(team) {
  return {
    CF_ACCESS_TEAM_DOMAIN: `${team}.cloudflareaccess.com`,
    CF_ACCESS_APP_AUD: "aud-prod",
    BANDROOM_OWNER_EMAIL: "owner@example.com",
    BANDROOM_OWNER_USER_ID: "owner-user-id",
    BANDROOM_RUNNER_CLIENT_ID: "runner-client-id",
    BANDROOM_COACH_CLIENT_ID: "coach-client-id",
  };
}
function matrixClaims(env, overrides = {}) {
  return {
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    aud: "aud-prod", exp: Math.floor(NOW / 1000) + 600, nbf: Math.floor(NOW / 1000) - 10,
    email: "owner@example.com", sub: "s", ...overrides,
  };
}
async function authResult(token, env) {
  return resolveAuthContext(new Headers({"cf-access-jwt-assertion": token}), env, {
    now: NOW, fetcher: jwksFetcher(), production: false,
  });
}

test("cross-application token (wrong aud) is rejected", async () => {
  const env = matrixEnv("xapp-team");
  const token = await signToken(key, "matrix-kid", matrixClaims(env, {aud: "aud-qa"}));
  assert.equal((await authResult(token, env)).user, null);
});

test("expired and nbf-future tokens are rejected", async () => {
  const env = matrixEnv("clock-team");
  const expired = await signToken(key, "matrix-kid", matrixClaims(env, {exp: Math.floor(NOW / 1000) - 1}));
  assert.equal((await authResult(expired, env)).user, null);
  const early = await signToken(key, "matrix-kid", matrixClaims(env, {nbf: Math.floor(NOW / 1000) + 60}));
  assert.equal((await authResult(early, env)).user, null);
});

test("wrong signature and wrong Client ID are rejected", async () => {
  const env = matrixEnv("sigmatrix-team");
  const forged = await signToken(otherKey, "matrix-kid", matrixClaims(env));
  assert.equal((await authResult(forged, env)).user, null);
  const wrongClient = await signToken(key, "matrix-kid", matrixClaims(env, {
    email: undefined, common_name: "not-the-runner", sub: "",
  }));
  assert.equal((await authResult(wrongClient, env)).user, null);
});

// --- browser routes reject service identities ------------------------------
test("every browser route rejects coach and coach-runner identities", async () => {
  for (const scope of ["coach", "coach-runner"]) {
    globalThis.__secCtx = service(scope);
    const checks = [
      ["state GET", await state.GET()],
      ["state PUT", await state.PUT(sameOrigin("/api/state", {method: "PUT"}))],
      ["audio GET", await audio.GET(sameOrigin("/api/audio?id=11111111-1111-4111-8111-111111111111"))],
      ["audio POST", await audio.POST(sameOrigin("/api/audio", {method: "POST"}))],
      ["coach GET", await coach.GET()],
      ["takeover POST", await takeover.POST(jsonBody("/api/review-tasks/takeover", {attemptId: "x"}))],
      ["backup GET", await backup.GET(sameOrigin("/api/backup"))],
      ["backup POST", await backup.POST(sameOrigin("/api/backup", {method: "POST"}))],
    ];
    for (const [label, response] of checks) {
      assert.equal(response.status, 403, `${scope} ${label}`);
      assert.deepEqual(await response.json(), {error: "owner_scope_required"}, `${scope} ${label}`);
    }
  }
});

test("anonymous browser routes return 401", async () => {
  globalThis.__secCtx = anonymous;
  assert.equal((await state.GET()).status, 401);
  assert.equal((await coach.GET()).status, 401);
});

// --- read-only mirror ------------------------------------------------------
test("read-only mode rejects every write while owner reads still pass the guard", async () => {
  globalThis.__secCtx = owner;
  setEnv({BANDROOM_READONLY: "1"});
  const writes = [
    ["state PUT", await state.PUT(sameOrigin("/api/state", {method: "PUT"}))],
    ["audio POST", await audio.POST(sameOrigin("/api/audio", {method: "POST"}))],
    ["takeover POST", await takeover.POST(jsonBody("/api/review-tasks/takeover", {attemptId: "x"}))],
    ["backup POST", await backup.POST(sameOrigin("/api/backup", {method: "POST"}))],
  ];
  for (const [label, response] of writes) {
    assert.equal(response.status, 403, label);
    assert.deepEqual(await response.json(), {error: "read_only"}, label);
  }
  setEnv();
});

// --- grant routes ----------------------------------------------------------
test("grant routes refuse workers.dev host swaps and foreign origins", async () => {
  setEnv({BANDROOM_PUBLIC_ORIGIN: origin, ANALYSIS_SIGNING_KEY: "s".repeat(32)});
  const evilHost = new Request("https://study.example/api/analysis-bundle?token=abc.def", {
    headers: {host: "attacker.workers.dev"},
  });
  const evilUrl = new Request("https://attacker.workers.dev/api/analysis-bundle?token=abc.def");
  for (const request of [evilHost, evilUrl]) {
    const response = await bundle.GET(request);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {error: "untrusted_origin"});
  }
  const transferEvil = await transfer.GET(new Request("https://attacker.workers.dev/api/review-transfer"));
  assert.equal(transferEvil.status, 403);
  assert.deepEqual(await transferEvil.json(), {error: "untrusted_origin"});

  const canonical = await bundle.GET(new Request("https://study.example/api/analysis-bundle?token=abc.def"));
  assert.equal(canonical.status, 403);
  assert.deepEqual(await canonical.json(), {error: "bundle_access_denied"}, "canonical host reached token verification");
  setEnv();
});

// --- MCP scope -------------------------------------------------------------
const rpc = body => sameOrigin("/mcp", {
  method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
});

test("MCP requires identity and enforces the scope matrix", async () => {
  globalThis.__secCtx = anonymous;
  const denied = await mcp.POST(rpc({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "read_study_session", arguments: {}}}));
  assert.equal(denied.status, 401);

  globalThis.__secCtx = {user: ownerUser, scope: "coach-runner", identityType: "access-jwt"};
  const publish = await mcp.POST(rpc({jsonrpc: "2.0", id: 2, method: 'tools/call', params: {name: "publish_lesson", arguments: {}}}));
  assert.equal(publish.status, 403);
  const publishBody = await publish.json();
  assert.equal(publishBody.error.code, -32003);

  globalThis.__secCtx = owner;
  const unknown = await mcp.POST(rpc({jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "not_a_tool", arguments: {}}}));
  assert.equal(unknown.status, 403);
  assert.equal((await unknown.json()).error.code, -32003);

  setEnv({BANDROOM_READONLY: "1"});
  const write = await mcp.POST(rpc({jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "report_scheduler_heartbeat", arguments: {}}}));
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error.code, -32004);
  setEnv();
});