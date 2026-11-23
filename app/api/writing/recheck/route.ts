import { requireUserScope } from "@/lib/route-guard";
import { createRecheck, RecheckError } from "@/lib/writing-recheck";
import { checkQueueDepth, checkSubmissionQuota, QuotaError, quotaEnabled, quotaResponse } from "@/lib/quota";
import { env } from "cloudflare:workers";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

/** "我改好了吗？" (doc §4.5): queue one advisory single-issue quick check. */
export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;
  const body = await limitedBody(request, 32 * 1024);
  if (body instanceof Response) return body;
  let input: { issueId?: unknown; revised?: unknown; why?: unknown } = {};
  try { input = JSON.parse(new TextDecoder().decode(body)) as typeof input; } catch { /* invalid JSON */ }
  if (typeof input.issueId !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(input.issueId)
      || typeof input.revised !== "string" || !input.revised.trim() || input.revised.length > 12000
      || (input.why !== undefined && typeof input.why !== "string"))
    return json({ error: "invalid_request" }, 400);
  const quotaEnv = env as { DB?: unknown; BANDROOM_QUOTA_GATE?: string };
  try {
    const userId = auth.user.userId;
    return json(await createRecheck(userId, { issueId: input.issueId, revised: input.revised, why: input.why as string | undefined }, {
      beforeInsert: async () => {
        if (quotaEnv.DB && quotaEnabled(quotaEnv)) {
          await checkQueueDepth(quotaEnv.DB as never, userId);
          await checkSubmissionQuota(quotaEnv.DB as never, userId);
        }
      },
    }));
  } catch (error) {
    if (error instanceof QuotaError) return quotaResponse(error);
    if (error instanceof RecheckError) return json({ error: error.code }, error.status);
    return json({ error: "recheck_failed" }, 503);
  }
}
