// Auth adapter unit tests. No network: JWKS responses and signed tokens are
// generated locally with WebCrypto. Run with node --experimental-strip-types.
import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";

const mock = source => ({url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return mock("export const env=globalThis.__authEnv??{}");
    if (specifier === "next/headers") return mock("export async function headers(){return new Headers(globalThis.__authHeaders??{})}");
    // MT-2: the adapter imports lib/pat, which uses the @/db schema alias.
    if (specifier.startsWith("@/")) return {url: new URL("../" + specifier.slice(2) + ".ts", import.meta.url).href, shortCircuit: true};
    // Node's type-stripping loader requires an extension; the app build resolves
    // extensionless relative imports. Mirror that here (e.g. ./tenant-identity).
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return next(specifier + ".ts", context);
    return next(specifier, context);
  },
});
const {resolveAuthContext} = await import("../lib/auth-adapter.ts");

const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
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

async function signToken(key, kid, claims, header = {}) {
  const head = b64url(encoder.encode(JSON.stringify({alg: "RS256", kid, typ: "JWT", ...header})));
  const body = b64url(encoder.encode(JSON.stringify(claims)));
  const input = `${head}.${body}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.pair.privateKey, encoder.encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

function jwksFetcher(keys) {
  const state = {calls: 0, urls: []};
  const fetcher = async url => {
    state.calls += 1;
    state.urls.push(url);
    const snapshot = typeof keys === "function" ? keys(state.calls) : keys;
    return new Response(JSON.stringify({keys: snapshot}), {
      status: 200, headers: {"content-type": "application/json"},
    });
  };
  return {fetcher, state};
}

function envFor(team = "team-a") {
  return {
    CF_ACCESS_TEAM_DOMAIN: `${team}.cloudflareaccess.com`,
    CF_ACCESS_APP_AUD: "aud-prod",
    BANDROOM_OWNER_EMAIL: "Owner@Example.com",
    BANDROOM_OWNER_USER_ID: "owner-user-id",
    BANDROOM_RUNNER_CLIENT_ID: "runner-client-id",
    BANDROOM_COACH_CLIENT_ID: "coach-client-id",
  };
}

function claimsFor(env, overrides = {}) {
  return {
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    aud: env.CF_ACCESS_APP_AUD,
    exp: NOW_SECONDS + 600,
    nbf: NOW_SECONDS - 10,
    email: "owner@example.com",
    sub: "subject-1",
    ...overrides,
  };
}

const jwtHeaders = token => new Headers({"cf-access-jwt-assertion": token});

async function resolve(token, env, options = {}) {
  const mock = jwksFetcher(options.keys ?? []);
  const context = await resolveAuthContext(jwtHeaders(token), env, {
    now: NOW, fetcher: options.fetcher ?? mock.fetcher, production: false,
  });
  return {context, state: mock.state};
}

const keyA = await makeKey("kid-a");
const keyB = await makeKey("kid-b");

test("owner email claim maps to the owner scope with the configured userId", async () => {
  const env = envFor("owner-team");
  const token = await signToken(keyA, "kid-a", claimsFor(env));
  const {context, state} = await resolve(token, env, {keys: [keyA.jwk]});
  assert.deepEqual(context, {
    user: {userId: "owner-user-id", displayName: "owner@example.com", email: "owner@example.com", fullName: null},
    scope: "owner",
    identityType: "access-jwt",
  });
  assert.equal(state.urls[0], `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
});

test("service token Client ID maps to coach-runner and coach scopes", async () => {
  const runnerEnv = envFor("runner-team");
  const runnerToken = await signToken(keyA, "kid-a", claimsFor(runnerEnv, {
    email: undefined, common_name: "runner-client-id", sub: "",
  }));
  const runner = (await resolve(runnerToken, runnerEnv, {keys: [keyA.jwk]})).context;
  assert.equal(runner.scope, "coach-runner");
  assert.equal(runner.identityType, "access-jwt");
  assert.equal(runner.user.userId, "owner-user-id");
  assert.equal(runner.user.email, "");

  const coachEnv = envFor("coach-team");
  const coachToken = await signToken(keyA, "kid-a", claimsFor(coachEnv, {
    email: undefined, common_name: "coach-client-id", sub: "",
  }));
  const coach = (await resolve(coachToken, coachEnv, {keys: [keyA.jwk]})).context;
  assert.equal(coach.scope, "coach");
});

test("unknown Client ID and missing scope are anonymous, never owner", async () => {
  const env = envFor("unknown-team");
  const token = await signToken(keyA, "kid-a", claimsFor(env, {
    email: "someone@example.com", common_name: "different-client-id",
  }));
  const {context} = await resolve(token, env, {keys: [keyA.jwk]});
  assert.deepEqual(context, {user: null, scope: null, identityType: null});
});

test("team domain without a suffix is normalized to cloudflareaccess.com", async () => {
  const env = {...envFor("short-team"), CF_ACCESS_TEAM_DOMAIN: "short-team"};
  const claims = claimsFor({...env, CF_ACCESS_TEAM_DOMAIN: "short-team.cloudflareaccess.com"});
  const token = await signToken(keyA, "kid-a", claims);
  const {context} = await resolve(token, env, {keys: [keyA.jwk]});
  assert.equal(context.scope, "owner");
});

test("wrong audience is rejected (cross-application replay)", async () => {
  const env = envFor("aud-team");
  const token = await signToken(keyA, "kid-a", claimsFor(env, {aud: "aud-qa"}));
  const {context} = await resolve(token, env, {keys: [keyA.jwk]});
  assert.equal(context.user, null);
  assert.equal(context.scope, null);
});

test("audience arrays are accepted only when they contain the pinned AUD", async () => {
  const env = envFor("aud-array-team");
  const token = await signToken(keyA, "kid-a", claimsFor(env, {aud: ["aud-qa", "aud-prod"]}));
  const {context} = await resolve(token, env, {keys: [keyA.jwk]});
  assert.equal(context.scope, "owner");
});

test("expired and not-yet-valid tokens are rejected", async () => {
  const env = envFor("time-team");
  const expired = await signToken(keyA, "kid-a", claimsFor(env, {exp: NOW_SECONDS - 1}));
  assert.equal((await resolve(expired, env, {keys: [keyA.jwk]})).context.user, null);

  const future = await signToken(keyA, "kid-a", claimsFor(env, {nbf: NOW_SECONDS + 60}));
  assert.equal((await resolve(future, env, {keys: [keyA.jwk]})).context.user, null);

  const noExp = await signToken(keyA, "kid-a", claimsFor(env, {exp: undefined}));
  assert.equal((await resolve(noExp, env, {keys: [keyA.jwk]})).context.user, null);
});

test("wrong issuer, wrong signature and unknown kid are rejected", async () => {
  const env = envFor("sig-team");
  const wrongIssuer = await signToken(keyA, "kid-a", claimsFor(env, {iss: "https://evil.cloudflareaccess.com"}));
  assert.equal((await resolve(wrongIssuer, env, {keys: [keyA.jwk]})).context.user, null);

  const wrongSignature = await signToken(keyB, "kid-a", claimsFor(env));
  assert.equal((await resolve(wrongSignature, env, {keys: [keyA.jwk]})).context.user, null);

  const unknownKid = await signToken(keyA, "kid-z", claimsFor(env));
  assert.equal((await resolve(unknownKid, env, {keys: [keyA.jwk]})).context.user, null);
});

test("non-RS256 algorithms are rejected before key selection", async () => {
  const env = envFor("alg-team");
  const head = b64url(encoder.encode(JSON.stringify({alg: "none", kid: "kid-a", typ: "JWT"})));
  const body = b64url(encoder.encode(JSON.stringify(claimsFor(env))));
  assert.equal((await resolve(`${head}.${body}.`, env, {keys: [keyA.jwk]})).context.user, null);

  const hsHead = b64url(encoder.encode(JSON.stringify({alg: "HS256", kid: "kid-a", typ: "JWT"})));
  const hsToken = `${hsHead}.${body}.${b64url(encoder.encode("signature"))}`;
  assert.equal((await resolve(hsToken, env, {keys: [keyA.jwk]})).context.user, null);
});

test("missing configuration fails closed even for a valid token", async () => {
  const env = envFor("config-team");
  const token = await signToken(keyA, "kid-a", claimsFor(env));
  for (const missing of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_APP_AUD", "BANDROOM_OWNER_USER_ID"]) {
    const broken = {...env, [missing]: undefined};
    assert.equal((await resolve(token, broken, {keys: [keyA.jwk]})).context.user, null, missing);
  }
  const noOwnerEmail = {...env, BANDROOM_OWNER_EMAIL: undefined};
  assert.equal((await resolve(token, noOwnerEmail, {keys: [keyA.jwk]})).context.user, null);
});

test("JWKS fetch failures fail closed", async () => {
  const env = envFor("fetch-team");
  const token = await signToken(keyA, "kid-a", claimsFor(env));
  const context = await resolveAuthContext(jwtHeaders(token), env, {
    now: NOW, production: false, fetcher: async () => { throw new Error("offline"); },
  });
  assert.equal(context.user, null);
});

test("key rotation refetches JWKS when a new kid appears", async () => {
  const env = envFor("rotate-team");
  const first = keyA.jwk.kid;
  const rotating = call => call === 1 ? [keyA.jwk] : [keyA.jwk, keyB.jwk];
  const fetcher = jwksFetcher(rotating);
  const tokenA = await signToken(keyA, first, claimsFor(env));
  const contextA = await resolveAuthContext(jwtHeaders(tokenA), env, {now: NOW, fetcher: fetcher.fetcher, production: false});
  assert.equal(contextA.scope, "owner");
  assert.equal(fetcher.state.calls, 1);

  const tokenB = await signToken(keyB, keyB.jwk.kid, claimsFor(env));
  const contextB = await resolveAuthContext(jwtHeaders(tokenB), env, {now: NOW, fetcher: fetcher.fetcher, production: false});
  assert.equal(contextB.scope, "owner");
  assert.equal(fetcher.state.calls, 2);
});

test("portable loopback mock works only on loopback and outside production", async () => {
  const headers = new Headers({
    host: "localhost:5173",
    "oai-authenticated-user-id": "local_seedy",
    "oai-authenticated-user-email": "seedy@sites.test",
    "oai-authenticated-user-full-name": "Seedy",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  const context = await resolveAuthContext(headers, {}, {production: false});
  assert.deepEqual(context, {
    user: {userId: "local_seedy", displayName: "Seedy", email: "seedy@sites.test", fullName: "Seedy"},
    scope: "owner",
    identityType: "mock",
  });

  const production = await resolveAuthContext(headers, {}, {production: true});
  assert.equal(production.user, null);

  const remote = new Headers({...Object.fromEntries(headers), host: "study.example"});
  const remoteContext = await resolveAuthContext(remote, {}, {production: false});
  assert.equal(remoteContext.user, null);
});

test("oai-authenticated headers are not trusted for a hosted non-loopback request", async () => {
  const headers = new Headers({
    host: "study.example",
    "oai-authenticated-user-id": "forged",
    "oai-authenticated-user-email": "forged@example.com",
  });
  const context = await resolveAuthContext(headers, envFor("hosted-team"), {production: false});
  assert.deepEqual(context, {user: null, scope: null, identityType: null});
});

test("missing assertion is anonymous", async () => {
  const context = await resolveAuthContext(new Headers({host: "study.example"}), envFor("empty-team"), {production: false});
  assert.deepEqual(context, {user: null, scope: null, identityType: null});
});