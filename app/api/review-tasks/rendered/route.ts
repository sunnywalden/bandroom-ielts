import { requireUserScope } from "@/lib/route-guard";
import { findReviewTaskByAttempt, recordFeedbackRendered, reviewTaskDb } from "@/lib/review-tasks";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Phase 0 telemetry (doc §4.2-⑤): the browser reports the first time a
 * completed review was actually rendered for the learner, so "time to visible
 * feedback" is measured instead of modelled. Timing only — no learner content.
 * Idempotent per task: only the first render is recorded.
 */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;
  const body = await limitedBody(request, 4 * 1024);
  if (body instanceof Response) return body;
  let attemptId: string | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { attemptId?: unknown };
    if (typeof parsed.attemptId === "string" && parsed.attemptId.length > 0 && parsed.attemptId.length <= 200)
      attemptId = parsed.attemptId;
  } catch { /* invalid JSON */ }
  if (!attemptId) return json({ error: "invalid_request" }, 400);
  const db = reviewTaskDb();
  try {
    const task = await findReviewTaskByAttempt(db, auth.user.userId, attemptId);
    if (!task || task.state !== "completed") return json({ recorded: false });
    const recorded = await recordFeedbackRendered(db, auth.user.userId, task.id);
    return json({ recorded });
  } catch {
    return json({ recorded: false });
  }
}
