// Self-hosted identity adapter (design rev2 §4.2). Cloudflare Access asserts
// identity with a signed JWT; the portable sites dev server keeps its loopback
// mock. Unknown or missing scopes are anonymous, never owner (fail-closed).
import { env as cloudflareEnv } from "cloudflare:workers";
import { headers } from "next/headers";
import { resolveTenant, splitList, type TenantDb } from "./tenant-identity";

export type AuthScope = "owner" | "learner" | "coach" | "coach-runner";
export type AuthUser = { userId: string; displayName: string; email: string; fullName: string | null };
export type AuthContext = {
  user: AuthUser | null;
  scope: AuthScope | null;
  identityType: "mock" | "access-jwt" | null;
};
export type AuthEnv = {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_APP_AUD?: string;
  BANDROOM_OWNER_EMAIL?: string;
  BANDROOM_OWNER_USER_ID?: string;
  BANDROOM_RUNNER_CLIENT_ID?: string;
  BANDROOM_COACH_CLIENT_ID?: string;
  // Multi-tenant (rev2 §3.1). DB is the D1 binding; domains gate provisioning;
  // admin emails resolve to active admin tenants. Absent DB → non-owner
  // identities fail closed (anonymous), preserving single-owner behaviour.
  DB?: unknown;
  BANDROOM_ALLOWED_EMAIL_DOMAINS?: string;
  BANDROOM_ADMIN_EMAILS?: string;
};
export type ResolveAuthOptions = {
  now?: number;
  fetcher?: typeof fetch;
  production?: boolean;
};

type HeadersLike = { get(name: string): string | null };
type AccessClaims = {
  iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown;
  email?: unknown; common_name?: unknown; sub?: unknown;
};
type JwksSnapshot = Map<string, JsonWebKey>;

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JWKS_TTL_MS = 60 * 60_000;
const jwksCache = new Map<string, { keys: JwksSnapshot; at: number }>();
const keyCache = new Map<string, Promise<CryptoKey>>();

function anonymous(): AuthContext {
  return { user: null, scope: null, identityType: null };
}

function productionBuild(): boolean {
  try {
    return typeof process !== "undefined" && process.env?.NODE_ENV === "production";
  } catch {
    return false;
  }
}

function loopbackHost(host: string | null): boolean {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1"
      || hostname === "::1" || hostname === "::ffff:127.0.0.1";
  } catch {
    return false;
  }
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// Portable sites mock: the vite plugin injects oai-authenticated-* headers on
// loopback only. They are never trusted for a hosted/production request.
function mockContext(requestHeaders: HeadersLike, production: boolean): AuthContext | null {
  if (production || !loopbackHost(requestHeaders.get("host"))) return null;
  const userId = requestHeaders.get(USER_ID_HEADER);
  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!userId || !email) return null;
  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName = encodedFullName
    && requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
    ? safeDecodeURIComponent(encodedFullName) : null;
  return {
    user: { userId, displayName: fullName ?? email, email, fullName },
    scope: "owner",
    identityType: "mock",
  };
}

function issuerFor(teamDomain: string): string | null {
  let value = teamDomain.trim();
  if (/^https:\/\//i.test(value)) value = value.slice(8);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  value = value.split(/[/?#]/)[0].trim();
  if (!value || !/^[A-Za-z0-9.-]+$/.test(value)) return null;
  return value.includes(".") ? `https://${value}` : `https://${value}.cloudflareaccess.com`;
}

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid_base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function jsonPart<T>(value: string): T {
  return JSON.parse(decoder.decode(base64UrlBytes(value))) as T;
}

async function fetchJwks(issuer: string, fetcher: typeof fetch, refresh: boolean): Promise<JwksSnapshot> {
  if (!refresh) {
    const cached = jwksCache.get(issuer);
    if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  }
  const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("jwks_unavailable");
  const body = await response.json() as { keys?: unknown };
  const keys: JwksSnapshot = new Map();
  if (Array.isArray(body.keys)) {
    for (const item of body.keys) {
      if (!item || typeof item !== "object") continue;
      const jwk = item as JsonWebKey & { kid?: unknown; use?: unknown };
      if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      keys.set(jwk.kid, jwk);
    }
  }
  jwksCache.set(issuer, { keys, at: Date.now() });
  return keys;
}

function audienceMatches(value: unknown, configured: string): boolean {
  const expected = configured.split(",").map(entry => entry.trim()).filter(Boolean);
  if (typeof value === "string") return expected.includes(value);
  if (Array.isArray(value)) return value.some(entry => typeof entry === "string" && expected.includes(entry));
  return false;
}

function serviceUser(userId: string, name: string): AuthUser {
  return { userId, displayName: name, email: "", fullName: null };
}

// Identity resolution (rev2 §3.1). Service tokens and the env owner keep the
// existing single-owner behaviour during expansion; any other verified human
// identity is resolved/provisioned from the `users` table. Only an `active`
// tenant yields the learner scope; pending/suspended/revoked → null. DB failures
// propagate to null (anonymous) — fail-closed, and the env owner path does not
// depend on D1.
async function resolveIdentity(
  claims: AccessClaims,
  authEnv: AuthEnv,
): Promise<{ scope: AuthScope; user: AuthUser } | null> {
  const userId = authEnv.BANDROOM_OWNER_USER_ID?.trim();
  const commonName = typeof claims.common_name === "string" ? claims.common_name.trim() : "";
  const runner = authEnv.BANDROOM_RUNNER_CLIENT_ID?.trim();
  const coach = authEnv.BANDROOM_COACH_CLIENT_ID?.trim();
  if (runner && commonName === runner) {
    return userId ? { scope: "coach-runner", user: serviceUser(userId, commonName) } : null;
  }
  if (coach && commonName === coach) {
    return userId ? { scope: "coach", user: serviceUser(userId, commonName) } : null;
  }
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (!email) return null;
  const ownerEmail = authEnv.BANDROOM_OWNER_EMAIL?.trim();
  if (ownerEmail && email.toLowerCase() === ownerEmail.toLowerCase()) {
    if (!userId) return null;
    // H14: seed the owner's users row so the future lease validator (which
    // checks users.status/revocation_epoch) does not break the owner queue.
    // Best-effort: if DB is unavailable the env owner path still works.
    const db = (authEnv.DB ?? null) as TenantDb | null;
    if (db) {
      try {
        const now = Date.now();
        await db.prepare(
          "INSERT INTO users (user_id, idp_iss, idp_sub, email_normalized, role, status, created_at, updated_at) " +
          "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status='active', updated_at=?",
        ).bind(userId, String(claims.iss ?? "env-owner"), String(claims.sub ?? userId),
          email.toLowerCase(), "admin", "active", now, now, now).run();
      } catch { /* best-effort seed; env owner auth does not depend on it */ }
    }
    return { scope: "owner", user: { userId, displayName: email, email, fullName: null } };
  }
  const tenant = await resolveTenant(
    (authEnv.DB ?? null) as TenantDb | null,
    { idpIss: String(claims.iss ?? ""), idpSub: String(claims.sub ?? ""), email },
    {
      allowedDomains: splitList(authEnv.BANDROOM_ALLOWED_EMAIL_DOMAINS),
      adminEmails: splitList(authEnv.BANDROOM_ADMIN_EMAILS),
    },
    Date.now(),
  );
  if (!tenant || tenant.status !== "active") return null;
  return { scope: "learner", user: { userId: tenant.userId, displayName: email, email, fullName: null } };
}

async function accessJwtContext(
  assertion: string,
  authEnv: AuthEnv,
  options: ResolveAuthOptions,
): Promise<AuthContext | null> {
  const team = authEnv.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = authEnv.CF_ACCESS_APP_AUD?.trim();
  if (!team || !audience) return null;
  const issuer = issuerFor(team);
  if (!issuer) return null;

  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return null;
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = jsonPart(parts[0]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;

  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetch;
  let keys: JwksSnapshot;
  try {
    keys = await fetchJwks(issuer, fetcher, false);
    if (!keys.has(header.kid)) keys = await fetchJwks(issuer, fetcher, true);
  } catch {
    return null;
  }
  const jwk = keys.get(header.kid);
  if (!jwk) return null;

  const cacheKey = `${issuer}#${header.kid}`;
  let keyPromise = keyCache.get(cacheKey);
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    keyCache.set(cacheKey, keyPromise);
  }
  let key: CryptoKey;
  try {
    key = await keyPromise;
  } catch {
    keyCache.delete(cacheKey);
    return null;
  }

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]) as BufferSource,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  let claims: AccessClaims;
  try {
    claims = jsonPart(parts[1]);
  } catch {
    return null;
  }
  if (claims.iss !== issuer) return null;
  if (!audienceMatches(claims.aud, audience)) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
  if (claims.nbf !== undefined
    && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)) return null;

  const resolved = await resolveIdentity(claims, authEnv);
  if (!resolved) return null;
  return { user: resolved.user, scope: resolved.scope, identityType: "access-jwt" };
}

export async function resolveAuthContext(
  requestHeaders: HeadersLike,
  authEnv: AuthEnv = {},
  options: ResolveAuthOptions = {},
): Promise<AuthContext> {
  const production = options.production ?? productionBuild();
  const mock = mockContext(requestHeaders, production);
  if (mock) return mock;

  const assertion = requestHeaders.get(ACCESS_JWT_HEADER);
  if (!assertion) return anonymous();
  try {
    return (await accessJwtContext(assertion, authEnv, options)) ?? anonymous();
  } catch {
    return anonymous();
  }
}

export async function getAuthContext(): Promise<AuthContext> {
  try {
    const requestHeaders = await headers();
    return await resolveAuthContext(requestHeaders, cloudflareEnv as AuthEnv);
  } catch {
    return anonymous();
  }
}