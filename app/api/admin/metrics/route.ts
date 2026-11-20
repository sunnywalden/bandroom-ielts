import { getDb } from "@/db";
import { metricsSummary, staleQueueAlerts } from "@/lib/metrics";
import { requireAdminScope } from "@/lib/route-guard";
import { json } from "../../shared";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * MT-4 admin observability (design rev3.1 §4.8). Content-blind aggregates only.
 *   GET ?day=YYYY-MM-DD   per-tenant metrics for that UTC day (default: today)
 *   GET ?alerts=1         tenants whose oldest queued task is stale
 */
export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;
  const db = getDb().$client;

  if (params.get("alerts") === "1") {
    const rawThreshold = params.get("thresholdMs");
    let thresholdMs: number | undefined;
    if (rawThreshold !== null) {
      thresholdMs = Number(rawThreshold);
      if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
        return json({ error: "invalid_threshold" }, 400);
      }
    }
    return json({ alerts: await staleQueueAlerts(db, Date.now(), thresholdMs) });
  }

  const day = params.get("day") || new Date().toISOString().slice(0, 10);
  if (!DAY.test(day)) return json({ error: "invalid_day" }, 400);
  return json({ day, metrics: await metricsSummary(db, day) });
}