// MT-5 per-tenant model entitlements (design rev3.1 G4 / license gate).
//
// The Stage B detector is trained on NC-licensed data (L2-ARCTIC CC BY-NC) and
// the contrast TTS is a commercial service. Neither may run for a tenant unless
// explicitly entitled. DEFAULT DENY: a missing or revoked row means OFF.
//
// The deployment owner (BANDROOM_OWNER_USER_ID) is entitled by virtue of the
// single-owner personal-use license posture; extending to other tenants requires
// the license② re-evaluation (owner/legal decision) plus an explicit grant here.
//
// The runner enforces this per task tenant before invoking detector/TTS. This
// module is the Worker-side source of truth + admin grant/revoke surface.
import { and, eq, isNull } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { userEntitlements } from "@/db/schema";
import type * as schema from "@/db/schema";

export type EntitlementDb = DrizzleD1Database<typeof schema>;

export const FEATURES = ["detector_self_listen", "contrast_tts"] as const;
export type Feature = typeof FEATURES[number];

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

function ownerUserId(): string | undefined {
  return (env as { BANDROOM_OWNER_USER_ID?: string }).BANDROOM_OWNER_USER_ID?.trim() || undefined;
}

/**
 * True when the tenant may use the feature. The owner is entitled by deployment
 * posture; everyone else needs an explicit, unrevoked grant. Fail-closed.
 */
export async function hasEntitlement(db: EntitlementDb, userId: string, feature: Feature): Promise<boolean> {
  if (!userId) return false;
  const owner = ownerUserId();
  if (owner && userId === owner) return true;
  const row = await db.select({ revokedAt: userEntitlements.revokedAt })
    .from(userEntitlements)
    .where(and(eq(userEntitlements.userId, userId), eq(userEntitlements.feature, feature)))
    .get();
  return Boolean(row && row.revokedAt === null);
}

export async function grantEntitlement(
  db: EntitlementDb, userId: string, feature: Feature, grantedBy: string,
): Promise<{ granted: boolean }> {
  if (!isFeature(feature)) return { granted: false };
  const now = Date.now();
  await db.insert(userEntitlements)
    .values({ userId, feature, grantedBy, grantedAt: now, revokedAt: null })
    .onConflictDoUpdate({
      target: [userEntitlements.userId, userEntitlements.feature],
      set: { grantedBy, grantedAt: now, revokedAt: null },
    })
    .run();
  return { granted: true };
}

export async function revokeEntitlement(
  db: EntitlementDb, userId: string, feature: Feature,
): Promise<{ revoked: boolean }> {
  const now = Date.now();
  const row = await db.update(userEntitlements)
    .set({ revokedAt: now })
    .where(and(eq(userEntitlements.userId, userId), eq(userEntitlements.feature, feature), isNull(userEntitlements.revokedAt)))
    .returning({ userId: userEntitlements.userId })
    .get();
  return { revoked: Boolean(row) };
}

export async function listEntitlements(db: EntitlementDb, userId: string): Promise<Array<{
  feature: string; grantedBy: string; grantedAt: number; revokedAt: number | null;
}>> {
  return db.select({
    feature: userEntitlements.feature,
    grantedBy: userEntitlements.grantedBy,
    grantedAt: userEntitlements.grantedAt,
    revokedAt: userEntitlements.revokedAt,
  }).from(userEntitlements).where(eq(userEntitlements.userId, userId)).all();
}