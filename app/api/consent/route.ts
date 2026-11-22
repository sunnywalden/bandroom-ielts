// MT-3 consent API (design rev3.1 §4.7). Learners grant/withdraw voice-processing
// consent here; the server-side gate (lib/consent.ts) enforces it on every voice
// path regardless of UI. GET returns the current status for the consent screen.
import { requireUserScope } from "@/lib/route-guard";
import { getTenantDb } from "@/db";
import {
  consentStatus, recordConsent, withdrawConsent, requiredConsentVersion, CONSENT_PURPOSE,
} from "@/lib/consent";
import { crossOrigin, json, limitedBody } from "../shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireUserScope();
  if (auth instanceof Response) return auth;
  return json(await consentStatus(getTenantDb(auth.user.userId), auth.user.userId));
}

export async function POST(request: Request) {
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  if (request.headers.get("X-Bandroom-Account") !== auth.user.userId)
    return json({ error: "refresh_account" }, 428);
  const body = await limitedBody(request, 4 * 1024);
  if (body instanceof Response) return body;
  let payload: { action?: string; version?: string; purpose?: string };
  try { payload = JSON.parse(new TextDecoder().decode(body)); }
  catch { return json({ error: "invalid_json" }, 400); }

  if (payload.action === "withdraw") {
    const result = await withdrawConsent(getTenantDb(auth.user.userId), auth.user.userId);
    return json(result);
  }
  // Grant: the client must affirm the CURRENT required version (no stale consent).
  const version = payload.version?.trim();
  if (version !== requiredConsentVersion())
    return json({ error: "consent_version_mismatch", required: requiredConsentVersion() }, 422);
  const result = await recordConsent(getTenantDb(auth.user.userId), auth.user.userId, version, payload.purpose?.trim() || CONSENT_PURPOSE);
  if (!result.recorded) return json({ error: "tenant_not_active" }, 403);
  return json(result);
}