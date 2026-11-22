import { env } from "cloudflare:workers";
import { requireUserScope } from "@/lib/route-guard";
import { asTenantId } from "@/lib/tenant-db";
import { scopedTenantDb } from "@/lib/tenant-repository";
import { aggregateProgress, PROGRESS_ROW_LIMIT, PROGRESS_WINDOW_DAYS, progressCutoff, type ProgressDbRow } from "@/lib/speaking-progress";
import { json } from "../../shared";

export const dynamic = "force-dynamic";

// P0-5: read-only projection of scorecard evidence. The query includes only
// learner_feedback columns needed for the charts; transcripts, quotes and
// drafts never leave D1. Rows without a scorecard are counted as legacy and
// malformed JSON is skipped rather than turning the whole panel into a 500.
export async function GET() {
  const auth = await requireUserScope();
  if (auth instanceof Response) return auth;
  if (!env.DB) return json({ error: "progress_unavailable" }, 503);
  const db = scopedTenantDb(env.DB, asTenantId(auth.user.userId));
  const cutoff = progressCutoff(Date.now(), PROGRESS_WINDOW_DAYS);
  const result = await db.prepare(
    `SELECT id, day, attempt AS attempt_id, created_at, analysis_json
       FROM teacher_feedback
      WHERE user_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(auth.user.userId, cutoff, PROGRESS_ROW_LIMIT + 1).all<ProgressDbRow>();
  const rows = (result.results ?? []).slice(0, PROGRESS_ROW_LIMIT);
  return json(aggregateProgress(rows, {
    truncated: (result.results ?? []).length > PROGRESS_ROW_LIMIT,
    windowDays: PROGRESS_WINDOW_DAYS,
  }));
}
