// MT-5 admin model-entitlement management (design rev3.1 G4 / license gate).
// Grant/revoke per-tenant detector/TTS entitlement. Extending beyond the owner
// requires the license② re-evaluation; this route is the enforcement surface.
import { getDb } from "@/db";
import { requireAdminScope } from "@/lib/route-guard";
import {
  grantEntitlement, revokeEntitlement, listEntitlements, isFeature, type Feature,
} from "@/lib/entitlement";
import { logAdminAudit } from "@/lib/admin";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const userId = new URL(request.url).searchParams.get("userId") ?? "";
  if (!userId) return json({ error: "userId_required" }, 400);
  return json({ userId, entitlements: await listEntitlements(getDb(), userId) });
}

export async function POST(request: Request) {
  const auth = await requireAdminScope({ write: true });
  if (auth instanceof Response) return auth;
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const body = await limitedBody(request, 4 * 1024);
  if (body instanceof Response) return body;
  let payload: { userId?: string; feature?: string; action?: string };
  try { payload = JSON.parse(new TextDecoder().decode(body)); }
  catch { return json({ error: "invalid_json" }, 400); }
  const userId = payload.userId?.trim();
  const feature = payload.feature?.trim();
  if (!userId || !feature || !isFeature(feature))
    return json({ error: "invalid_entitlement", features: ["detector_self_listen", "contrast_tts"] }, 422);

  if (payload.action === "revoke") {
    const result = await revokeEntitlement(getDb(), userId, feature as Feature);
    await logAdminAudit(getDb(), { actorUserId: auth.user.userId, action: "entitlement_revoke", targetUserId: userId, metadata: { feature } });
    return json(result);
  }
  const result = await grantEntitlement(getDb(), userId, feature as Feature, auth.user.userId);
  await logAdminAudit(getDb(), { actorUserId: auth.user.userId, action: "entitlement_grant", targetUserId: userId, metadata: { feature } });
  return json(result);
}