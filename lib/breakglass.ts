// Break-glass capability (design rev3.1 §4.6 / S10.1).
//
// A break-glass grant is a short-lived, HMAC-signed, READ-ONLY capability that
// binds an admin actor to ONE target tenant. It is not a session: every read
// must present the grant, and the admin route audits synchronously before any
// content is returned. The payload is signed exactly like lib/lease.ts signs a
// lease (base64url(payload).base64url(HMAC-SHA256)), so a leaked grant can only
// read the bound target until exp.
//
// Key: BANDROOM_BREAKGLASS_KEY (32-byte hex). If absent we fall back to
// ANALYSIS_SIGNING_KEY so existing deployments do not need a new secret before
// the break-glass key is provisioned. Absent both, issue returns null and
// verify fails closed.
import { env } from "cloudflare:workers";

const VERSION = 1;
const DOMAIN = "brbg1";
const encoder = new TextEncoder();

export type BreakglassPayload = {
  v: number;
  targetUid: string;
  actorUid: string;
  ops: string[];
  exp: number; // epoch milliseconds
  reason: string;
};

export type BreakglassError =
  | "breakglass_missing"
  | "breakglass_invalid"
  | "breakglass_expired"
  | "breakglass_ops_denied";

export type IssueBreakglassInput = {
  targetUid: string;
  actorUid: string;
  ops?: string[];
  exp: number;
  reason: string;
};

function hexToBytes(hex: string): Uint8Array {
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

// A 32-byte hex key is decoded to raw bytes. A non-hex fallback secret
// (ANALYSIS_SIGNING_KEY is historically an opaque string) is used as UTF-8, so
// the fallback keeps working without re-keying the deployment.
function keyMaterial(): Uint8Array | null {
  const candidates = [
    (env as { BANDROOM_BREAKGLASS_KEY?: string }).BANDROOM_BREAKGLASS_KEY,
    (env as { ANALYSIS_SIGNING_KEY?: string }).ANALYSIS_SIGNING_KEY,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    if (/^[0-9a-f]{64}$/i.test(value)) return hexToBytes(value);
    return encoder.encode(value);
  }
  return null;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Sign a grant payload. Returns null when no signing key is configured. */
export async function issueBreakglassGrant(input: IssueBreakglassInput): Promise<string | null> {
  const raw = keyMaterial();
  if (!raw) return null;
  const targetUid = input.targetUid?.trim();
  const actorUid = input.actorUid?.trim();
  const reason = input.reason?.trim();
  if (!targetUid || !actorUid || !reason) return null;
  if (!Number.isFinite(input.exp)) return null;
  const payload: BreakglassPayload = {
    v: VERSION,
    targetUid,
    actorUid,
    ops: input.ops?.length ? [...input.ops] : ["read"],
    exp: input.exp,
    reason,
  };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(raw);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${DOMAIN}|${encoded}`));
  return `${encoded}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verify a grant and return its payload. HMAC is checked over the exact encoded
 * segment BEFORE JSON parsing (constant-time via crypto.subtle.verify). Throws a
 * BreakglassError code on any failure.
 */
export async function verifyBreakglassGrant(token: string | undefined | null): Promise<BreakglassPayload> {
  if (!token) throw new Error("breakglass_missing" satisfies BreakglassError);
  const raw = keyMaterial();
  if (!raw) throw new Error("breakglass_invalid" satisfies BreakglassError);
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) throw new Error("breakglass_invalid" satisfies BreakglassError);
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const key = await importKey(raw);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC", key, fromBase64Url(signature) as BufferSource, encoder.encode(`${DOMAIN}|${encoded}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("breakglass_invalid" satisfies BreakglassError);

  let payload: BreakglassPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as BreakglassPayload;
  } catch {
    throw new Error("breakglass_invalid" satisfies BreakglassError);
  }
  if (!payload || payload.v !== VERSION) throw new Error("breakglass_invalid" satisfies BreakglassError);
  if (typeof payload.targetUid !== "string" || !payload.targetUid.trim()) {
    throw new Error("breakglass_invalid" satisfies BreakglassError);
  }
  if (typeof payload.actorUid !== "string" || !payload.actorUid.trim()) {
    throw new Error("breakglass_invalid" satisfies BreakglassError);
  }
  if (!Array.isArray(payload.ops) || payload.ops.length === 0) {
    throw new Error("breakglass_invalid" satisfies BreakglassError);
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("breakglass_invalid" satisfies BreakglassError);
  }
  if (payload.exp <= Date.now()) throw new Error("breakglass_expired" satisfies BreakglassError);
  // S10.1: grants are read-only. A write op can never be carried.
  if (!payload.ops.includes("read") || payload.ops.some(op => op !== "read")) {
    throw new Error("breakglass_ops_denied" satisfies BreakglassError);
  }
  return payload;
}

/** True when a signing key is available. */
export function breakglassEnabled(): boolean {
  return keyMaterial() !== null;
}