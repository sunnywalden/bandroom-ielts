import { getDb } from "@/db";
import { analysisEvents } from "@/db/schema";
import type { AuthContext } from "@/lib/auth-adapter";

// Audit service-identity MCP calls into the existing append-only analysis_events
// table (design rev2 §4.3). Records identity/tool/task/fence/outcome only —
// never recording bytes, feedback text, or other learner content. Fire-and-
// forget: an audit failure must never break the coaching request.
//
// Tenant attribution (rev2 S10 / S7.1): a service identity may only attribute a
// row to a tenant proven by a verified task lease. Without one, the taskId in
// the request body is unverified — looking it up and copying its owner would let
// a service identity pollute another tenant's audit trail. So an unverified call
// is recorded as a service-scoped row (userId=null, taskId=null).
export async function auditServiceCall(
  auth: AuthContext,
  tool: string,
  args: unknown,
  result: unknown,
  verifiedUid?: string,
): Promise<void> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const isError = Boolean((result as { isError?: boolean } | null)?.isError);
    const db = getDb();
    const taskId = verifiedUid && typeof a.taskId === "string" ? a.taskId : null;
    const userId: string | null = verifiedUid ?? null;
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