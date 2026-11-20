import { count, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { learnerStates, teacherFeedback } from "@/db/schema";
import { logAdminAudit } from "@/lib/admin";
import { issueBreakglassGrant, verifyBreakglassGrant } from "@/lib/breakglass";
import {
  currentAuthContext,
  evaluateAdminScope,
  evaluateBreakglassScope,
  requireAdminScope,
} from "@/lib/route-guard";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

const bodySpec = z.strictObject({
  targetUserId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
  ttlMs: z.number().int().min(1_000).max(MAX_TTL_MS).optional(),
});

/** Issue a short-lived, read-only, target-bound break-glass grant. */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireAdminScope({ write: true });
  if (auth instanceof Response) return auth;
  const body = await limitedBody(request, 8 * 1024);
  if (body instanceof Response) return body;
  let input: z.infer<typeof bodySpec>;
  try {
    input = bodySpec.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const expiresAt = Date.now() + (input.ttlMs ?? DEFAULT_TTL_MS);
  const grant = await issueBreakglassGrant({
    targetUid: input.targetUserId,
    actorUid: auth.user.userId,
    ops: ["read"],
    exp: expiresAt,
    reason: input.reason,
  });
  if (!grant) return json({ error: "breakglass_unavailable" }, 503);

  const db = getDb();
  // S10.1: audit synchronously BEFORE the grant leaves the server.
  await logAdminAudit(db, {
    actorUserId: auth.user.userId,
    action: "breakglass_grant",
    targetUserId: input.targetUserId,
    reason: input.reason,
    expiresAt,
  });
  return json({ grant, expiresAt, targetUserId: input.targetUserId });
}

/**
 * Read-only target summary behind a grant. Minimal by design: revision and
 * feedback count only, never answers or feedback text. The audit row is written
 * synchronously BEFORE any target data is queried/returned.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const grant = url.searchParams.get("grant");
  const path = url.searchParams.get("path") ?? "summary";
  const requestedTarget = url.searchParams.get("targetUserId");

  // Break-glass semantics: owner/admin with a grant, or a target-bound
  // breakglass session. Writes are never accepted on this route.
  const context = await currentAuthContext();
  const admin = evaluateAdminScope(context);
  let actorUserId: string;
  if (admin instanceof Response) {
    const breakglass = evaluateBreakglassScope(context);
    if (breakglass instanceof Response) return admin;
    actorUserId = breakglass.user.userId;
  } else {
    actorUserId = admin.user.userId;
  }

  let payload;
  try {
    payload = await verifyBreakglassGrant(grant);
  } catch (error) {
    const code = error instanceof Error ? error.message : "breakglass_invalid";
    const status = code === "breakglass_missing" || code === "breakglass_expired" ? 401 : 403;
    return json({ error: code }, status);
  }
  const targetUserId = payload.targetUid;
  if (requestedTarget && requestedTarget !== targetUserId) {
    return json({ error: "grant_target_mismatch" }, 403);
  }
  // A grant is bound to its issuing actor (admin path) and to one target. A
  // breakglass-scoped session is itself target-bound, so its userId must match.
  if (context.scope === "breakglass") {
    if (actorUserId !== targetUserId) return json({ error: "grant_target_mismatch" }, 403);
  } else if (payload.actorUid !== actorUserId) {
    return json({ error: "grant_actor_mismatch" }, 403);
  }
  if (path.length > 200) return json({ error: "invalid_path" }, 400);

  const db = getDb();
  // S10.1 + S10.2: synchronous audit before returning any target data.
  await logAdminAudit(db, {
    actorUserId,
    action: "breakglass_read",
    targetUserId,
    metadata: { path },
  });

  const state = await db.select({ revision: learnerStates.revision })
    .from(learnerStates).where(eq(learnerStates.userId, targetUserId)).get();
  const feedback = await db.select({ count: count() })
    .from(teacherFeedback).where(eq(teacherFeedback.userId, targetUserId)).get();
  return json({
    targetUserId,
    path,
    revision: state?.revision ?? 0,
    feedbackCount: Number(feedback?.count ?? 0),
    readAt: Date.now(),
  });
}