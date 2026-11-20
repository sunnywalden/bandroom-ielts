import { getDb } from "@/db";
import { queueStats } from "@/lib/admin";
import { requireAdminScope } from "@/lib/route-guard";
import { json } from "../../shared";

export const dynamic = "force-dynamic";

/** Per-tenant review queue counts (state only, never attempt content). */
export async function GET() {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  return json({ queue: await queueStats(getDb()) });
}