import { z } from "zod/v4";
import { getDb } from "@/db";
import { approveUser, revokeUser, suspendUser } from "@/lib/admin";
import { requireAdminScope } from "@/lib/route-guard";
import { crossOrigin, json, limitedBody } from "../../../shared";

export const dynamic = "force-dynamic";

const bodySpec = z.strictObject({
  action: z.enum(["approve", "suspend", "revoke"]),
  reason: z.string().trim().min(1).max(500).optional(),
});

type RouteContext = { params: Promise<{ id: string }> | { id: string } | null };

/** Tenant lifecycle transitions. The target id comes from the URL, never a body. */
export async function POST(request: Request, context: RouteContext) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const params = await context?.params;
  const targetUserId = params?.id;
  if (!targetUserId) return json({ error: "invalid_request" }, 400);

  const body = await limitedBody(request, 8 * 1024);
  if (body instanceof Response) return body;
  let input: z.infer<typeof bodySpec>;
  try {
    input = bodySpec.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const db = getDb();
  const actorUserId = auth.user.userId;
  switch (input.action) {
    case "approve":
      return json(await approveUser(db, actorUserId, targetUserId));
    case "suspend":
      return json(await suspendUser(db, actorUserId, targetUserId, input.reason ?? "admin_action"));
    case "revoke":
      return json(await revokeUser(db, actorUserId, targetUserId, input.reason ?? "admin_action"));
  }
}