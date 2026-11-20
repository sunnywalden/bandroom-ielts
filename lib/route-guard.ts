// Browser/API route authorization (design rev2 §4.2/§4.6). Only an owner
// session may use the learner-facing routes. Service tokens (coach,
// coach-runner) are confined to /mcp and the grant endpoints.
import * as authModule from "@/app/chatgpt-auth";
import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { env } from "cloudflare:workers";
import type { AuthContext } from "@/lib/auth-adapter";
import { json } from "@/app/api/shared";

type AuthModuleShape = {
  getAuthContext?: () => Promise<AuthContext>;
  getChatGPTUser?: () => Promise<ChatGPTUser | null>;
};
// Namespace access keeps the historical test doubles working: some suites mock
// @/app/chatgpt-auth with getChatGPTUser only. The real module always exports
// getAuthContext, so the legacy branch is unreachable in production.
const auth = authModule as unknown as AuthModuleShape;

export async function currentAuthContext(): Promise<AuthContext> {
  if (typeof auth.getAuthContext === "function") return auth.getAuthContext();
  const user = typeof auth.getChatGPTUser === "function" ? await auth.getChatGPTUser() : null;
  return { user, scope: user ? "owner" : null, identityType: user ? "mock" : null };
}

export function readOnlyMode(): boolean {
  return (env as { BANDROOM_READONLY?: string }).BANDROOM_READONLY === "1";
}

export type OwnerScopeResult = { user: ChatGPTUser } | Response;

export function evaluateOwnerScope(
  context: AuthContext,
  options: { write?: boolean } = {},
): OwnerScopeResult {
  if (!context.user) return json({ error: "sign_in_required" }, 401);
  // Strict owner/admin gate. Cross-tenant and global operations (e.g.
  // /api/migrate) must keep this gate; do NOT widen it to learners.
  if (context.scope !== "owner") return json({ error: "owner_scope_required" }, 403);
  if (options.write && readOnlyMode()) return json({ error: "read_only" }, 403);
  return { user: context.user };
}

export async function requireOwnerScope(
  options: { write?: boolean } = {},
): Promise<OwnerScopeResult> {
  return evaluateOwnerScope(await currentAuthContext(), options);
}

// Distinct tenant guard (rev2 §3.1): authorises any ACTIVE tenant (owner or
// learner) to act on its OWN userId. It deliberately does not grant cross-tenant
// or global access — entity-level ownership is enforced because every caller
// scopes its queries/objects to context.user.userId (see app/api/state,
// audio, coach, backup, takeover). Do NOT use this for admin/global operations;
// those keep requireOwnerScope. Never let a request-supplied userId reach a query.
export function evaluateUserScope(
  context: AuthContext,
  options: { write?: boolean } = {},
): OwnerScopeResult {
  if (!context.user) return json({ error: "sign_in_required" }, 401);
  // MT-2: admin also owns its own learner data (own userId). breakglass is
  // read-only and target-bound — it must NOT pass the generic user guard for
  // writes; use evaluateBreakglassScope for read-only target access.
  if (context.scope !== "owner" && context.scope !== "learner" && context.scope !== "admin") {
    return json({ error: "owner_scope_required" }, 403);
  }
  if (options.write && readOnlyMode()) return json({ error: "read_only" }, 403);
  return { user: context.user };
}

export async function requireUserScope(
  options: { write?: boolean } = {},
): Promise<OwnerScopeResult> {
  return evaluateUserScope(await currentAuthContext(), options);
}

// MT-2 (S10.1): admin management gate. Only owner or admin may reach the
// /api/admin/* aggregate routes. Admin is content-blind by default; cross-tenant
// content requires an explicit break-glass grant (evaluateBreakglassScope).
export function evaluateAdminScope(context: AuthContext): OwnerScopeResult {
  if (!context.user) return json({ error: "sign_in_required" }, 401);
  if (context.scope !== "owner" && context.scope !== "admin") {
    return json({ error: "admin_scope_required" }, 403);
  }
  return { user: context.user };
}

export async function requireAdminScope(): Promise<OwnerScopeResult> {
  return evaluateAdminScope(await currentAuthContext());
}

// MT-2 (S10.1): break-glass is a distinct READ-ONLY, target-bound scope. It is
// rejected on every write/global route. The grant {targetUid, ops, exp, reason}
// is validated per request and audited synchronously before content returns.
// This function only authorises the scope shape; the grant check + audit live
// in lib/breakglass.ts and are enforced by the admin read route.
export function evaluateBreakglassScope(
  context: AuthContext,
  options: { write?: boolean } = {},
): OwnerScopeResult {
  if (!context.user) return json({ error: "sign_in_required" }, 401);
  if (context.scope !== "breakglass") return json({ error: "breakglass_scope_required" }, 403);
  if (options.write) return json({ error: "breakglass_read_only" }, 403);
  if (readOnlyMode()) return json({ error: "read_only" }, 403);
  return { user: context.user };
}

// Grant routes must be reached on the configured canonical origin. A request
// routed by Host: *.workers.dev (or any other host) is refused even with a
// valid HMAC grant.
export function isCanonicalOrigin(request: Request): boolean {
  const configured = (env as { BANDROOM_PUBLIC_ORIGIN?: string }).BANDROOM_PUBLIC_ORIGIN?.trim();
  if (!configured) return false;
  let expected: URL;
  try {
    expected = new URL(configured);
  } catch {
    return false;
  }
  if (expected.protocol !== "https:" && expected.protocol !== "http:") return false;
  let actual: URL;
  try {
    actual = new URL(request.url);
  } catch {
    return false;
  }
  if (actual.protocol !== expected.protocol) return false;
  const host = (request.headers.get("host") ?? actual.host).toLowerCase();
  if (host !== expected.host.toLowerCase() || actual.host.toLowerCase() !== expected.host.toLowerCase()) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(`${expected.protocol}//${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname !== "workers.dev" && !hostname.endsWith(".workers.dev");
}