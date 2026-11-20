import { getDb } from "@/db";
import { costAggregate } from "@/lib/admin";
import { requireAdminScope } from "@/lib/route-guard";
import { json } from "../../shared";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Per-tenant spend aggregate for one UTC day. Defaults to today (UTC). */
export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const day = new URL(request.url).searchParams.get("day") || new Date().toISOString().slice(0, 10);
  if (!DAY.test(day)) return json({ error: "invalid_day" }, 400);
  return json({ day, users: await costAggregate(getDb(), day) });
}