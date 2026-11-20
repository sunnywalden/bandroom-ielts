import { z } from "zod/v4";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { logAdminAudit } from "@/lib/admin";
import { dsrDownloadResponse, exportDsr, runDsrDelete } from "@/lib/dsr";
import { requireAdminScope } from "@/lib/route-guard";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;

const bodySpec = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  kind: z.enum(["export", "delete"]),
  reason: z.string().trim().min(1).max(500),
});

function parseManifest(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Admin DSR operations (design rev3.1 §4.7).
 * POST {userId, kind:'export'|'delete', reason} — export returns a JSON
 * download; delete runs the resumable job and returns its manifest. Both are
 * audited. GET ?userId= lists the tenant's jobs without cursor contents.
 */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireAdminScope({ write: true });
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
  const actorUserId = auth.user.userId;

  if (input.kind === "export") {
    try {
      const bundle = await exportDsr(db, env.BUCKET, input.userId);
      await logAdminAudit(db, {
        actorUserId,
        action: "dsr_export",
        targetUserId: input.userId,
        reason: input.reason,
      });
      return dsrDownloadResponse(bundle, input.userId);
    } catch {
      return json({ error: "dsr_export_failed" }, 500);
    }
  }

  const jobId = crypto.randomUUID();
  try {
    const result = await runDsrDelete(db, env.BUCKET, input.userId, jobId, actorUserId);
    await logAdminAudit(db, {
      actorUserId,
      action: "dsr_delete",
      targetUserId: input.userId,
      reason: input.reason,
      metadata: { jobId },
    });
    return json({ jobId: result.jobId, status: result.status, manifest: result.manifest });
  } catch {
    try {
      await logAdminAudit(db, {
        actorUserId,
        action: "dsr_delete",
        targetUserId: input.userId,
        reason: input.reason,
        metadata: { jobId, failed: true },
      });
    } catch {
      // Preserve the original failure response.
    }
    // The job row keeps status='failed' and its cursor; a retry can resume.
    return json({ jobId, status: "failed", error: "dsr_delete_failed" }, 500);
  }
}

export async function GET(request: Request) {
  const auth = await requireAdminScope();
  if (auth instanceof Response) return auth;
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) return json({ error: "invalid_request" }, 400);
  const db = getDb();
  const result = await db.$client.prepare(
    "SELECT id,kind,status,created_at,finished_at,manifest_json FROM dsr_jobs " +
    "WHERE user_id=? ORDER BY created_at DESC, id DESC",
  ).bind(userId).all();
  const jobs = ((result.results ?? []) as Array<Record<string, unknown>>).map(row => ({
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    manifest: parseManifest(row.manifest_json),
  }));
  return json({ jobs });
}