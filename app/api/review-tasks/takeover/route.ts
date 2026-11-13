import { getChatGPTUser } from "@/app/chatgpt-auth";
import { claimManualReviewTask, findReviewTaskByAttempt, ReviewTaskError, reviewTaskDb } from "@/lib/review-tasks";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

/** Revoke any live automatic claim before the learner asks Work to review manually. */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  const body = await limitedBody(request, 8 * 1024);
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
    const task = await findReviewTaskByAttempt(db, user.userId, attemptId);
    if (!task) return json({ claimed: false, reason: "no_task" });
    if (task.state === "completed") return json({ error: "review_completed" }, 409);
    const claimed = await claimManualReviewTask(db, user.userId, task.id);
    if (!claimed) {
      const current = await findReviewTaskByAttempt(db, user.userId, attemptId);
      return current?.state === "completed"
        ? json({ error: "review_completed" }, 409)
        : json({ error: "review_busy" }, 503);
    }
    return json({ claimed: true, taskId: claimed.id, fence: claimed.fence, state: claimed.state });
  } catch (error) {
    if (error instanceof ReviewTaskError) {
      const status = error.code === "task_not_found" ? 404 : 409;
      return json({ error: error.code }, status);
    }
    return json({ error: "takeover_failed" }, 503);
  }
}
