import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { analysisEvents, reviewTasks } from "@/db/schema";
import type { AuthContext } from "@/lib/auth-adapter";

// Audit service-identity MCP calls into the existing append-only analysis_events
// table (design rev2 §4.3). Records identity/tool/task/fence/outcome only —
// never recording bytes, feedback text, or other learner content. Fire-and-
// forget: an audit failure must never break the coaching request.
//
// Tenant attribution (rev2 S10): the row is attributed to the tenant that owns
// the task (review_tasks.user_id), looked up server-side. A foreign or unknown
// taskId is dropped rather than attributed, so a service identity cannot write
// an audit row into another tenant's task.
export async function auditServiceCall(
  auth: AuthContext,
  tool: string,
  args: unknown,
  result: unknown,
): Promise<void> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const isError = Boolean((result as { isError?: boolean } | null)?.isError);
    const db = getDb();
    let taskId = typeof a.taskId === "string" ? a.taskId : null;
    let userId: string | null = null;
    if (taskId) {
      const row = await db.select({ userId: reviewTasks.userId }).from(reviewTasks)
        .where(eq(reviewTasks.id, taskId)).get();
      if (row?.userId) userId = row.userId;
      else taskId = null;
    }
    await db
      .insert(analysisEvents)
      .values({
        at: Date.now(),
        taskId,
        userId,
        fence: typeof a.fence === "number" ? a.fence : null,
        event: "mcp_service_call",
        stage: tool,
        outcome: isError ? "tool_error" : "ok",
        clientRunId: typeof a.clientRunId === "string" ? a.clientRunId : null,
        metadataJson: { scope: auth.scope, identityType: auth.identityType, tool },
      })
      .run();
  } catch {
    // Audit is best-effort; never surface to the caller.
  }
}