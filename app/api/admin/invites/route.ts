import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { invites } from "@/db/schema";
import { createInvite, maskEmail } from "@/lib/admin";
import { requireAdminScope } from "@/lib/route-guard";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

const bodySpec = z.strictObject({
  email: z.string().trim().email().max(320).optional(),
  role: z.enum(["learner", "admin"]).optional(),
  ttlMs: z.number().int().min(60_000).max(90 * 24 * 60 * 60 * 1000).optional(),
});

/** Invite metadata only. code_hash is never projected. */
export async function GET() {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const rows = await getDb().select({
    id: invites.id,
    email: invites.email,
    role: invites.role,
    expiresAt: invites.expiresAt,
    usedAt: invites.usedAt,
  }).from(invites).orderBy(desc(invites.expiresAt)).all();
  return json({ invites: rows.map(row => ({ ...row, email: maskEmail(row.email) })) });
}

/** Mint an invite. The plaintext code is returned exactly once. */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const body = await limitedBody(request, 8 * 1024);
  if (body instanceof Response) return body;
  let input: z.infer<typeof bodySpec>;
  try {
    input = bodySpec.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const created = await createInvite(getDb(), auth.user.userId, input);
  return json(created, 201);
}