import { getDb } from "@/db";
import { analysisEvents } from "@/db/schema";
import type { AuthContext } from "@/lib/auth-adapter";

// Audit service-identity MCP calls into the existing append-only analysis_events
// table (design rev2 §4.3). Records identity/tool/task/fence/outcome only —
// never recording bytes, feedback text, or other learner content. Fire-and-
// forget: an audit failure must never break the coaching request.
export function auditServiceCall(
  auth: AuthContext,
  tool: string,
  args: unknown,
  result: unknown,
): void {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const isError = Boolean((result as { isError?: boolean } | null)?.isError);
    void getDb()
      .insert(analysisEvents)
      .values({
        at: Date.now(),
        taskId: typeof a.taskId === "string" ? a.taskId : null,
        fence: typeof a.fence === "number" ? a.fence : null,
        event: "mcp_service_call",
        stage: tool,
        outcome: isError ? "tool_error" : "ok",
        clientRunId: typeof a.clientRunId === "string" ? a.clientRunId : null,
        metadataJson: { scope: auth.scope, identityType: auth.identityType, tool },
      })
      .run()
      .catch(() => {});
  } catch {
    // Audit is best-effort; never surface to the caller.
  }
}