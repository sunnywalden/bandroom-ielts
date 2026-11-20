import { z } from "zod/v4";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { logAdminAudit } from "@/lib/admin";
import { dsrDownloadResponse, exportDsr, runDsrDelete } from "@/lib/dsr";
import { requireUserScope } from "@/lib/route-guard";
import { crossOrigin, json, limitedBody } from "../shared";

export const dynamic = "force-dynamic";

const BODY_LIMIT = 4 * 1024;
const bodySpec = z.strictObject({ kind: z.enum(["export", "delete"]) });

/**
 * Self-service DSR (design rev3.1 §4.7). Operates ONLY on the authenticated
 * tenant's own userId; the request body can never name another tenant.
 */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;

  const bytes = await limitedBody(request, BODY_LIMIT);
  if (bytes instanceof Response) return bytes;
  let input: z.infer<typeof bodySpec>;
  try {
    input = bodySpec.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  if (!env.BUCKET) return json({ error: "storage_unavailable" }, 503);
  const db = getDb();
  const self = auth.user.userId;

  if (input.kind === "export") {
    try {
      return dsrDownloadResponse(await exportDsr(db, env.BUCKET, self), self);
    } catch {
      return json({ error: "dsr_export_failed" }, 500);
    }
  }

  const jobId = crypto.randomUUID();
  try {
    const result = await runDsrDelete(db, env.BUCKET, self, jobId, self);
    await logAdminAudit(db, {
      actorUserId: self,
      action: "dsr_delete",
      targetUserId: self,
      reason: "self_service",
      metadata: { jobId },
    });
    return json({ jobId: result.jobId, status: result.status, manifest: result.manifest });
  } catch {
    try {
      await logAdminAudit(db, {
        actorUserId: self,
        action: "dsr_delete",
        targetUserId: self,
        reason: "self_service",
        metadata: { jobId, failed: true },
      });
    } catch {
      // Preserve the original failure response.
    }
    return json({ jobId, status: "failed", error: "dsr_delete_failed" }, 500);
  }
}