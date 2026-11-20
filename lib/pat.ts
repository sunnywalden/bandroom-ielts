// Personal access tokens (MT-2, design rev3.1 §4.2).
//
// A PAT is a learner-scoped bearer credential for MCP connectors. The plaintext
// token is shown exactly once at creation; only its SHA-256 hash is stored. A
// token is bound to one userId and is revocable. Admin/aggregate operations are
// deliberately NOT reachable with a PAT (scope resolves to "learner").
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { userTokens } from "@/db/schema";
import * as schema from "@/db/schema";

const TOKEN_PREFIX = "brpat_";
const encoder = new TextEncoder();

export type PatDb = DrizzleD1Database<typeof schema>;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Create a PAT for one tenant. The plaintext token is returned exactly once. */
export async function createPat(
  db: PatDb,
  userId: string,
  label?: string,
): Promise<{ id: string; token: string; createdAt: number }> {
  const id = crypto.randomUUID();
  const token = TOKEN_PREFIX + randomHex(32);
  const tokenHash = await sha256Hex(token);
  const createdAt = Date.now();
  await db.insert(userTokens).values({
    id,
    userId,
    tokenHash,
    label: label?.trim() || null,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
  }).run();
  return { id, token, createdAt };
}

/** Resolve a bearer PAT to its tenant. Returns null for invalid/revoked tokens. */
export async function resolvePat(db: PatDb, token: string): Promise<{ userId: string } | null> {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.select({
    id: userTokens.id,
    userId: userTokens.userId,
  }).from(userTokens)
    .where(and(eq(userTokens.tokenHash, tokenHash), isNull(userTokens.revokedAt)))
    .get();
  if (!row) return null;
  await db.update(userTokens).set({ lastUsedAt: Date.now() })
    .where(eq(userTokens.id, row.id)).run();
  return { userId: row.userId };
}

/** Revoke one of the caller's own tokens. Another tenant's id never matches. */
export async function revokePat(
  db: PatDb,
  userId: string,
  tokenId: string,
): Promise<{ revoked: boolean }> {
  if (typeof tokenId !== "string" || !tokenId.trim()) return { revoked: false };
  const row = await db.update(userTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(userTokens.id, tokenId), eq(userTokens.userId, userId)))
    .returning({ id: userTokens.id })
    .get();
  return { revoked: Boolean(row) };
}

/** List the caller's own tokens. token_hash is never projected. */
export async function listPats(db: PatDb, userId: string): Promise<Array<{
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}>> {
  return db.select({
    id: userTokens.id,
    label: userTokens.label,
    createdAt: userTokens.createdAt,
    lastUsedAt: userTokens.lastUsedAt,
    revokedAt: userTokens.revokedAt,
  }).from(userTokens)
    .where(eq(userTokens.userId, userId))
    .orderBy(desc(userTokens.createdAt))
    .all();
}

/**
 * Resolve a PAT directly against a D1 binding (used by the auth adapter, which
 * sees cloudflareEnv.DB before a Drizzle instance exists). Fail-closed: any
 * driver error propagates to the caller, which treats it as anonymous.
 */
export async function resolvePatFromBinding(
  binding: unknown,
  token: string,
): Promise<{ userId: string } | null> {
  if (!binding || typeof (binding as { prepare?: unknown }).prepare !== "function") return null;
  const db = drizzle(binding as never, { schema }) as unknown as PatDb;
  return resolvePat(db, token);
}

/** Parse `Authorization: Bearer <token>` (scheme is case-insensitive). */
export function bearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return match ? match[1] : null;
}

export { TOKEN_PREFIX };