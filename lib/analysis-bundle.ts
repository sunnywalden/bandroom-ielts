import { env } from "cloudflare:workers";
import { getReviewTask, ReviewTaskError, type ReviewTaskDb } from "./review-tasks";

export type AnalysisBundleManifest = {
  version: string;
  bundleSha256: string;
  bytes: number;
  parts?: Array<{ name: string; sha256: string; bytes: number }>;
};

export type AnalysisBundleGrant = {
  version: string;
  url: string;
  expiresAt: number;
  bundleSha256: string;
  bytes: number;
  parts: AnalysisBundleManifest["parts"];
};

type SignedPayload = {
  v: 1; key: string; user: string; task: string; fence: number; iat: number; exp: number;
};

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signAnalysisGrant(secret: string, payload: unknown, scope = "") {
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(scope + body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyAnalysisGrant(secret: string, token: string, scope = ""): Promise<unknown> {
  if (token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret),
      fromBase64Url(parts[1]), encoder.encode(scope + parts[0]));
    return valid ? JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) : null;
  } catch {
    return null;
  }
}

export async function verifyBundleToken(secret: string, token: string, now = Date.now()) {
  const payload = await verifyAnalysisGrant(secret, token) as SignedPayload | null;
  if (payload?.v !== 1 || typeof payload.key !== "string" || typeof payload.user !== "string"
    || typeof payload.task !== "string" || !Number.isInteger(payload.fence)
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
  if (payload.exp <= now || payload.iat > now + 60_000) return null;
  return payload;
}

function hex64(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function bundleObjectKey(version: string) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(version)) throw new ReviewTaskError("bundle_version_invalid", "Invalid analysis bundle version.");
  return `analysis/${version}/bundle.tar.zst`;
}

export async function createAnalysisBundleGrant(
  db: ReviewTaskDb,
  userId: string,
  taskId: string,
  fence: number,
  options: { now?: number; secret?: string; origin?: string; version?: string; ttlMs?: number; bucket?: R2Bucket } = {},
): Promise<AnalysisBundleGrant> {
  const now = options.now ?? Date.now();
  const task = await getReviewTask(db, userId, taskId);
  if (!task) throw new ReviewTaskError("task_not_found", "The task is not available to this account.");
  if (task.state !== "running" || task.fence !== fence || (task.leaseUntil ?? 0) <= now)
    throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
  if (task.kind !== "speaking")
    throw new ReviewTaskError("not_speaking", "Only speaking tasks need an acoustic analysis bundle.");

  const bucket = options.bucket ?? env.BUCKET;
  if (!bucket) throw new ReviewTaskError("bundle_unavailable", "Analysis bundle storage is unavailable.");
  const version = options.version ?? task.analysisVersion ?? env.ANALYSIS_BUNDLE_VERSION;
  if (!version) throw new ReviewTaskError("bundle_version_missing", "No analysis bundle version is configured.");
  const key = bundleObjectKey(version);
  const manifestFile = await bucket.get(`analysis/${version}/manifest.json`);
  if (!manifestFile) throw new ReviewTaskError("bundle_unavailable", "The analysis bundle manifest is unavailable.");
  let manifest: AnalysisBundleManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as AnalysisBundleManifest;
  } catch {
    throw new ReviewTaskError("bundle_manifest_invalid", "The analysis bundle manifest is not valid JSON.");
  }
  if (!manifest || manifest.version !== version || !hex64(manifest.bundleSha256)
    || !Number.isInteger(manifest.bytes) || manifest.bytes <= 0)
    throw new ReviewTaskError("bundle_manifest_invalid", "The analysis bundle manifest is incomplete.");
  const object = await bucket.head(key);
  if (!object) throw new ReviewTaskError("bundle_unavailable", "The analysis bundle object is unavailable.");
  if (object.size !== manifest.bytes)
    throw new ReviewTaskError("bundle_manifest_mismatch", "The bundle size differs from its manifest.");

  const secret = options.secret ?? env.ANALYSIS_SIGNING_KEY;
  if (!secret || secret.length < 32)
    throw new ReviewTaskError("bundle_signing_unavailable", "Analysis bundle signing is not configured.");
  const origin = options.origin ?? env.BANDROOM_PUBLIC_ORIGIN;
  if (!origin || !/^https?:\/\//.test(origin))
    throw new ReviewTaskError("bundle_origin_unavailable", "The public site origin is not configured.");
  const requested = now + Math.max(60_000, Math.min(options.ttlMs ?? 10 * 60_000, 15 * 60_000));
  // H20: the grant must never outlive the task lease it was minted for, so a
  // completed/reclaimed task cannot be downloaded through a still-valid token.
  const expiresAt = Math.min(requested, task.leaseUntil ?? requested);
  const payload: SignedPayload = {
    v: 1, key, user: userId, task: taskId, fence, iat: now, exp: expiresAt,
  };
  const token = await signAnalysisGrant(secret, payload);
  return {
    version, expiresAt, bundleSha256: manifest.bundleSha256, bytes: manifest.bytes, parts: manifest.parts,
    url: `${origin.replace(/\/$/, "")}/api/analysis-bundle?token=${encodeURIComponent(token)}`,
  };
}
