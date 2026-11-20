import { getDb } from "@/db";
import { listUsers } from "@/lib/admin";
import { requireAdminScope } from "@/lib/route-guard";
import { json } from "../../shared";

export const dynamic = "force-dynamic";

/** Identity-only tenant list (S10.2). Optional ?status=pending|active|... */
export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  try {
    return json({ users: await listUsers(getDb(), { status }) });
  } catch {
    return json({ error: "invalid_status" }, 400);
  }
}