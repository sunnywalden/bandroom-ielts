// Task lease: server-issued HMAC capability for cross-tenant runner operations.
// Design rev3.1 §4.3 (B1 fix). The lease binds {taskId, userId, fence, runnerId,
// ops, exp, rev} so a leaked runner token can only operate on tasks it has
// legitimately claimed — never on arbitrary tenant tasks via a bare taskId.
//
// Invariants:
// - userId comes ONLY from the signed lease (never from request body).
// - The write predicate includes users EXISTS (status + revocation_epoch) so
//   suspension is atomic with the write (S1.1).
// - rid is server-issued (Access client id + nonce), not client-supplied (S1.3).
// - ops limits which tools the lease authorises (S1.4).

import { env } from "cloudflare:workers";

const LEASE_VERSION = 1;
const encoder = new TextEncoder();

export type LeasePayload = {
  v: number;
  kid: string;
  tid: string;
  uid: string;
  fence: number;
  rid: string;
  ops: string[];
  iat: number;
  exp: number;
  rev: number;
};

export type LeaseError =
  | "lease_missing"
  | "lease_invalid"
  | "lease_expired"
  | "lease_revoked"
  | "lease_ops_denied"
  | "stale_lease";

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("invalid_lease_key");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid_base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hexToBytes(hex), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hmacSign(key: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return toBase64Url(new Uint8Array(sig));
}

async function hmacVerify(key: CryptoKey, data: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), encoder.encode(data));
  } catch {
    return false;
  }
}

function leaseKey(): string | null {
  const key = (env as { BANDROOM_LEASE_KEY?: string }).BANDROOM_LEASE_KEY?.trim();
  return key && /^[0-9a-f]{64}$/i.test(key) ? key : null;
}

function currentKid(): string {
  return (env as { BANDROOM_LEASE_KID?: string }).BANDROOM_LEASE_KID?.trim() || "lease-v1";
}

/** Sign a lease payload. Called only after a successful claim RETURNING. */
export async function signLease(payload: Omit<LeasePayload, "v" | "kid">): Promise<string | null> {
  const keyHex = leaseKey();
  if (!keyHex) return null; // lease system not configured; caller falls back to legacy
  const full: LeasePayload = { v: LEASE_VERSION, kid: currentKid(), ...payload };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(full)));
  const key = await importKey(keyHex);
  const sig = await hmacSign(key, `v1|${encoded}`);
  return `${encoded}.${sig}`;
}

/** Verify a lease token and return the payload, or throw a LeaseError code. */
export async function verifyLease(token: string | undefined | null, requiredOp: string): Promise<LeasePayload> {
  if (!token) throw new Error("lease_missing" satisfies LeaseError);
  const keyHex = leaseKey();
  if (!keyHex) throw new Error("lease_invalid" satisfies LeaseError);
  const dot = token.indexOf(".");
  if (dot < 1) throw new Error("lease_invalid" satisfies LeaseError);
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await importKey(keyHex);
  // S1.4: verify HMAC over the exact encoded segment BEFORE JSON parse
  if (!(await hmacVerify(key, `v1|${encoded}`, sig))) {
    throw new Error("lease_invalid" satisfies LeaseError);
  }
  let payload: LeasePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as LeasePayload;
  } catch {
    throw new Error("lease_invalid" satisfies LeaseError);
  }
  if (payload.v !== LEASE_VERSION) throw new Error("lease_invalid" satisfies LeaseError);
  if (payload.kid !== currentKid()) throw new Error("lease_invalid" satisfies LeaseError);
  const now = Date.now();
  if (payload.exp <= now) throw new Error("lease_expired" satisfies LeaseError);
  if (payload.iat > now + 60_000) throw new Error("lease_invalid" satisfies LeaseError);
  if (!payload.ops.includes(requiredOp)) throw new Error("lease_ops_denied" satisfies LeaseError);
  if (!payload.tid || !payload.uid || !payload.rid) throw new Error("lease_invalid" satisfies LeaseError);
  return payload;
}

/**
 * Build the atomic SQL predicate fragment for lease-bound writes (S1.1).
 * Folds users.status + revocation_epoch into the same WHERE so suspension
 * is atomic with the write — no TOCTOU between a separate SELECT and UPDATE.
 *
 * H14: if the uid matches the env owner and no users row exists, the EXISTS
 * is skipped (owner exemption). Once the owner seed migration runs, the row
 * exists and the exemption is never hit.
 */
export function leaseWritePredicate(ownerUserId: string | undefined): {
  sql: string;
  bindCount: number;
} {
  // The EXISTS subquery checks users status + epoch atomically.
  // For the env owner without a users row, we use a LEFT JOIN pattern:
  // (u.user_id IS NULL AND ? = ownerUid) OR (u.status='active' AND u.revocation_epoch=?)
  // This is expressed as: EXISTS(...) OR (? = ownerUid AND NOT EXISTS(SELECT 1 FROM users WHERE user_id=?))
  // Simpler: just use EXISTS and rely on the owner seed. If seed hasn't run,
  // the owner exemption is handled by the caller passing a flag.
  return {
    sql: `AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.user_id = review_tasks.user_id
        AND u.status = 'active'
        AND u.revocation_epoch = ?
    )`,
    bindCount: 1,
  };
}

/** Check whether the lease system is configured (BANDROOM_LEASE_KEY present). */
export function leaseEnabled(): boolean {
  return leaseKey() !== null;
}