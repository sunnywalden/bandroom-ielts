// MT-2 admin operations (design rev3.1 §4.6 / S10.2).
//
// Admin functions are CONTENT-BLIND by default: they project only identity
// metadata, cost totals and queue counts. Learner content (answers, feedback,
// lessons) is never selected here. Cross-tenant content reads require a
// break-glass grant (lib/breakglass.ts) and are audited before returning.
//
// Every state-changing/security-relevant action appends to admin_audit. The
// audit row never contains learner content or plaintext tokens/invite codes.
import { and, asc, count, eq, gt, isNull, sql, sum } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import {
  adminAudit,
  invites,
  reviewTasks,
  userCostLedger,
  users,
} from "@/db/schema";
import type * as schema from "@/db/schema";

export type AdminDb = DrizzleD1Database<typeof schema>;

export type AdminAuditInput = {
  actorUserId: string;
  action: string;
  targetUserId?: string;
  reason?: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type UserStatus = "pending" | "active" | "suspended" | "revoked";

const STATUSES = new Set<string>(["pending", "active", "suspended", "revoked"]);
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

/** first char + ***@domain. Never returns the full local part. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const value = email.trim();
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return value[0] + "***";
  return value[0] + "***@" + value.slice(at + 1).toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    byte => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Append one audit row. Callers await this SYNCHRONOUSLY before returning. */
export async function logAdminAudit(db: AdminDb, input: AdminAuditInput): Promise<void> {
  await db.insert(adminAudit).values({
    at: Date.now(),
    actorUserId: input.actorUserId,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    reason: input.reason ?? null,
    expiresAt: input.expiresAt ?? null,
    metadataJson: input.metadata ?? null,
  }).run();
}

/**
 * Identity-only user list (S10.2). No learner content columns are selected.
 * Email is masked; users cannot be enumerated by full address from here.
 */
export async function listUsers(
  db: AdminDb,
  options: { status?: string } = {},
): Promise<Array<{
  userId: string;
  role: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  emailNormalized: string | null;
  consentVersion: string | null;
}>> {
  const status = options.status?.trim();
  if (status && !STATUSES.has(status)) throw new Error("invalid_status");
  const base = db.select({
    userId: users.userId,
    role: users.role,
    status: users.status,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    emailNormalized: users.emailNormalized,
    consentVersion: users.consentVersion,
  }).from(users);
  const rows = status
    ? await base.where(eq(users.status, status)).orderBy(asc(users.createdAt)).all()
    : await base.orderBy(asc(users.createdAt)).all();
  return rows.map(row => ({ ...row, emailNormalized: maskEmail(row.emailNormalized) }));
}

/** pending -> active (Z-1 approval gate). */
export async function approveUser(
  db: AdminDb,
  actorUserId: string,
  targetUserId: string,
): Promise<{ approved: boolean }> {
  const now = Date.now();
  const row = await db.update(users)
    .set({ status: "active", updatedAt: now })
    .where(and(eq(users.userId, targetUserId), eq(users.status, "pending")))
    .returning({ userId: users.userId })
    .get();
  const approved = Boolean(row);
  await logAdminAudit(db, {
    actorUserId,
    action: "approve",
    targetUserId,
    metadata: { approved },
  });
  return { approved };
}

/**
 * Suspend one tenant. S1.1: bump revocation_epoch so every lease-bound write
 * fails atomically, and invalidate in-flight runner leases by blocking running
 * review tasks (clearing lease_until so no runner can renew).
 */
export async function suspendUser(
  db: AdminDb,
  actorUserId: string,
  targetUserId: string,
  reason: string,
): Promise<{ suspended: boolean }> {
  const now = Date.now();
  await db.update(reviewTasks)
    .set({ state: "blocked", leaseUntil: null, updatedAt: now })
    .where(and(eq(reviewTasks.userId, targetUserId), eq(reviewTasks.state, "running")))
    .run();
  const row = await db.update(users)
    .set({
      status: "suspended",
      revocationEpoch: sql`${users.revocationEpoch} + 1`,
      updatedAt: now,
    })
    .where(eq(users.userId, targetUserId))
    .returning({ userId: users.userId })
    .get();
  const suspended = Boolean(row);
  await logAdminAudit(db, {
    actorUserId,
    action: "suspend",
    targetUserId,
    reason,
    metadata: { suspended },
  });
  return { suspended };
}

/**
 * Revoke one tenant. S9.3 tombstone: keep user_id + IdP (iss, sub) hash so a
 * re-login cannot mint a new tenant, but clear direct PII (email, display name)
 * and bump the epoch. Full DSR data deletion is MT-3.
 */
export async function revokeUser(
  db: AdminDb,
  actorUserId: string,
  targetUserId: string,
  reason: string,
): Promise<{ revoked: boolean }> {
  const now = Date.now();
  const row = await db.update(users)
    .set({
      status: "revoked",
      revokedAt: now,
      revocationEpoch: sql`${users.revocationEpoch} + 1`,
      emailNormalized: null,
      displayName: null,
      updatedAt: now,
    })
    .where(eq(users.userId, targetUserId))
    .returning({ userId: users.userId })
    .get();
  const revoked = Boolean(row);
  await logAdminAudit(db, {
    actorUserId,
    action: "revoke",
    targetUserId,
    reason,
    metadata: { revoked },
  });
  return { revoked };
}

/** Per-tenant spend for one UTC day. Aggregates only; no content. */
export async function costAggregate(
  db: AdminDb,
  utcDay: string,
): Promise<Array<{ userId: string; spentMicroCny: number }>> {
  const rows = await db.select({
    userId: userCostLedger.userId,
    spentMicroCny: sum(userCostLedger.spentMicroCny),
  }).from(userCostLedger)
    .where(eq(userCostLedger.utcDay, utcDay))
    .groupBy(userCostLedger.userId)
    .all();
  return rows.map(row => ({
    userId: row.userId,
    spentMicroCny: Number(row.spentMicroCny ?? 0),
  }));
}

/** Per-tenant review queue state counts. No attempt/answer content. */
export async function queueStats(
  db: AdminDb,
): Promise<Array<{ userId: string; state: string; count: number }>> {
  const rows = await db.select({
    userId: reviewTasks.userId,
    state: reviewTasks.state,
    count: count(),
  }).from(reviewTasks)
    .groupBy(reviewTasks.userId, reviewTasks.state)
    .all();
  return rows.map(row => ({ userId: row.userId, state: row.state, count: Number(row.count) }));
}

/**
 * Create an invite. Only the SHA-256 hash is stored; the plaintext code is
 * returned exactly once and never written to the audit trail.
 */
export async function createInvite(
  db: AdminDb,
  actorUserId: string,
  options: { email?: string; role?: "learner" | "admin"; ttlMs?: number } = {},
): Promise<{ id: string; code: string; role: "learner" | "admin"; expiresAt: number }> {
  const ttlMs = options.ttlMs ?? DEFAULT_INVITE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("invalid_ttl");
  const role = options.role === "admin" ? "admin" : "learner";
  const email = options.email?.trim().toLowerCase() || null;
  const id = crypto.randomUUID();
  const code = `brinv_${crypto.randomUUID().replace(/-/g, "")}${randomHex(16)}`;
  const codeHash = await sha256Hex(code);
  const expiresAt = Date.now() + ttlMs;
  await db.insert(invites).values({
    id,
    codeHash,
    email,
    role,
    expiresAt,
    createdBy: actorUserId,
    usedAt: null,
    usedBy: null,
  }).run();
  await logAdminAudit(db, {
    actorUserId,
    action: "invite_create",
    metadata: { inviteId: id, role, hasEmail: Boolean(email) },
  });
  return { id, code, role, expiresAt };
}

/**
 * Redeem an invite for a pending tenant. Valid only when unused, unexpired,
 * and (if the invite is addressed) the email matches the tenant's email.
 * Revoked tombstones are never resurrected.
 */
export async function redeemInvite(
  db: AdminDb,
  code: string,
  userId: string,
): Promise<{ redeemed: boolean }> {
  if (typeof code !== "string" || !code.trim()) return { redeemed: false };
  const codeHash = await sha256Hex(code.trim());
  const now = Date.now();
  const invite = await db.select({
    id: invites.id,
    email: invites.email,
    usedAt: invites.usedAt,
    expiresAt: invites.expiresAt,
  }).from(invites)
    .where(and(eq(invites.codeHash, codeHash), isNull(invites.usedAt), gt(invites.expiresAt, now)))
    .get();
  if (!invite) return { redeemed: false };

  const user = await db.select({
    userId: users.userId,
    emailNormalized: users.emailNormalized,
    status: users.status,
  }).from(users).where(eq(users.userId, userId)).get();
  if (!user || user.status === "revoked") return { redeemed: false };
  if (invite.email && invite.email.toLowerCase() !== String(user.emailNormalized ?? "").toLowerCase()) {
    return { redeemed: false };
  }

  const claimed = await db.update(invites)
    .set({ usedAt: now, usedBy: userId })
    .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
    .returning({ id: invites.id })
    .get();
  if (!claimed) return { redeemed: false };

  await db.update(users)
    .set({ status: "active", updatedAt: now })
    .where(eq(users.userId, userId))
    .run();
  await logAdminAudit(db, {
    actorUserId: userId,
    action: "invite_redeem",
    targetUserId: userId,
    metadata: { inviteId: invite.id },
  });
  return { redeemed: true };
}