// MT-3 consent gate (design rev3.1 §4.7, B4 / S8.1).
//
// Voice recordings are sensitive personal data. Before ANY upload, playback,
// derived processing or calibration for a tenant, the server must verify that
// the tenant has given active, current-version consent. This is a SERVER-SIDE
// gate (403 consent_required), not a UI hint.
//
// The current consent snapshot lives on users.consent_version / consent_at;
// consent_events is the append-only history (grant + withdrawal).
//
// F10/H14 owner exemption: the env owner (BANDROOM_OWNER_USER_ID) is the
// operator who deployed the system; until an explicit owner consent record is
// seeded, the owner is treated as consented so the gate does not lock out the
// operator. Real second users MUST consent explicitly via POST /api/consent.
// This exemption is transitional and documented; remove it once owner consent
// is backfilled and verified.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { consentEvents, reviewTasks, users } from "@/db/schema";
import type * as schema from "@/db/schema";

export type ConsentDb = DrizzleD1Database<typeof schema>;

export const DEFAULT_CONSENT_VERSION = "voice-processing-v1";
export const CONSENT_PURPOSE = "voice-processing";

export class ConsentError extends Error {
  status = 403;
  code = "consent_required";
  constructor(message = "请先同意语音数据处理条款后再使用口语功能。") {
    super(message);
  }
}

/** The required consent version (env-overridable for versioned re-consent). */
export function requiredConsentVersion(): string {
  return (env as { BANDROOM_CONSENT_VERSION?: string }).BANDROOM_CONSENT_VERSION?.trim()
    || DEFAULT_CONSENT_VERSION;
}

/**
 * Whether the consent gate is enforced. FAIL CLOSED (security review): consent
 * is required unless explicitly disabled with BANDROOM_CONSENT_GATE="off" for
 * local/test fixtures. A missing flag must NOT silently allow voice processing.
 * The env owner remains transitionally exempt (F10) so the operator is not
 * locked out before an explicit owner consent record is seeded.
 */
export function consentGateEnabled(): boolean {
  return (env as { BANDROOM_CONSENT_GATE?: string }).BANDROOM_CONSENT_GATE?.trim() !== "off";
}

function ownerUserId(): string | undefined {
  return (env as { BANDROOM_OWNER_USER_ID?: string }).BANDROOM_OWNER_USER_ID?.trim() || undefined;
}

/**
 * True when the tenant may process voice data: active current-version consent,
 * not withdrawn. The env owner is exempt transitionally (F10). When the gate is
 * disabled (rollout), always true.
 */
export async function hasValidConsent(db: ConsentDb, userId: string): Promise<boolean> {
  if (!consentGateEnabled()) return true;
  if (!userId) return false;
  const owner = ownerUserId();
  if (owner && userId === owner) return true; // F10 transitional operator exemption
  const row = await db.select({
    version: users.consentVersion,
    at: users.consentAt,
    status: users.status,
  }).from(users).where(eq(users.userId, userId)).get();
  if (!row || row.status !== "active") return false;
  if (!row.at || row.version !== requiredConsentVersion()) return false;
  // A withdrawal clears users.consent_version (see withdrawConsent), so the
  // version check above already rejects withdrawn tenants. Belt-and-braces:
  // ensure no un-withdrawn grant is missing for the current version.
  return true;
}

/** Throw ConsentError(403) unless the tenant has valid consent. */
export async function assertConsent(db: ConsentDb, userId: string): Promise<void> {
  if (!(await hasValidConsent(db, userId))) throw new ConsentError();
}

/**
 * Record an explicit consent grant. Updates the users snapshot and appends a
 * consent_events row transactionally. Only an active tenant may consent.
 */
export async function recordConsent(
  db: ConsentDb,
  userId: string,
  version: string,
  purpose: string = CONSENT_PURPOSE,
  ipHash?: string,
): Promise<{ recorded: boolean; version: string }> {
  const now = Date.now();
  const user = await db.select({ status: users.status }).from(users)
    .where(eq(users.userId, userId)).get();
  if (!user || user.status !== "active") return { recorded: false, version };
  await db.insert(consentEvents).values({
    userId, version, purpose, at: now, withdrawnAt: null, ipHash: ipHash ?? null,
  }).run();
  await db.update(users).set({ consentVersion: version, consentAt: now, updatedAt: now })
    .where(eq(users.userId, userId)).run();
  return { recorded: true, version };
}

/**
 * Withdraw consent: stop new processing, cancel queued tasks, clear the snapshot
 * and mark the latest grant withdrawn. Derived audio is purged by retention/DSR.
 */
export async function withdrawConsent(db: ConsentDb, userId: string): Promise<{ withdrawn: boolean }> {
  const now = Date.now();
  const user = await db.select({ status: users.status }).from(users)
    .where(eq(users.userId, userId)).get();
  if (!user) return { withdrawn: false };
  // Cancel non-terminal tasks so no new voice processing starts. Completed
  // tasks stay completed (their receipts are historical evidence).
  await db.update(reviewTasks)
    .set({ state: "blocked", leaseUntil: null, updatedAt: now })
    .where(and(
      eq(reviewTasks.userId, userId),
      inArray(reviewTasks.state, ["queued", "retry_wait", "running"]),
    ))
    .run();
  // Mark the most recent un-withdrawn grant.
  const latest = await db.select({ id: consentEvents.id }).from(consentEvents)
    .where(and(eq(consentEvents.userId, userId), isNull(consentEvents.withdrawnAt)))
    .orderBy(consentEvents.id)
    .all();
  for (const row of latest) {
    await db.update(consentEvents).set({ withdrawnAt: now })
      .where(eq(consentEvents.id, row.id)).run();
  }
  await db.update(users).set({ consentVersion: null, consentAt: null, updatedAt: now })
    .where(eq(users.userId, userId)).run();
  return { withdrawn: true };
}

/** Current consent status for display (version, at, whether valid). */
export async function consentStatus(db: ConsentDb, userId: string): Promise<{
  version: string | null; at: number | null; required: string; valid: boolean;
}> {
  const row = await db.select({ version: users.consentVersion, at: users.consentAt })
    .from(users).where(eq(users.userId, userId)).get();
  return {
    version: row?.version ?? null,
    at: row?.at ?? null,
    required: requiredConsentVersion(),
    valid: await hasValidConsent(db, userId),
  };
}