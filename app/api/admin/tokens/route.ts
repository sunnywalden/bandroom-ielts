import { z } from "zod/v4";
import { getDb } from "@/db";
import { createPat, listPats, revokePat } from "@/lib/pat";
import { requireUserScope } from "@/lib/route-guard";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

// PATs are self-service: a learner manages its OWN tokens. These routes use the
// tenant guard (requireUserScope), never requireAdminScope — a PAT can never
// mint or inspect another tenant's credential.
const bodySpec = z.strictObject({
  label: z.string().trim().max(120).optional(),
});

/** Create a PAT for the caller. The plaintext token is returned exactly once. */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;
  const body = await limitedBody(request, 4 * 1024);
  if (body instanceof Response) return body;
  let input: z.infer<typeof bodySpec> = {};
  try {
    input = bodySpec.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const created = await createPat(getDb(), auth.user.userId, input.label);
  return json(created, 201);
}

/** List the caller's own tokens. token_hash is never projected. */
export async function GET() {
  const auth = await requireUserScope();
  if (auth instanceof Response) return auth;
  return json({ tokens: await listPats(getDb(), auth.user.userId) });
}

/** Revoke one of the caller's own tokens: DELETE ?id=... */
export async function DELETE(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ error: "invalid_request" }, 400);
  const result = await revokePat(getDb(), auth.user.userId, id);
  return result.revoked ? json(result) : json({ error: "token_not_found" }, 404);
}