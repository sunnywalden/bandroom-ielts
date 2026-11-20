// Tenant identity resolution for multi-tenant soft isolation (rev2 §2.1/§3.1).
//
// Identity authority is the IdP (iss, sub) pair, not the mutable email. A
// first login from an allowed email domain provisions a `users` row with a
// new opaque UUID; default status is `pending` so an approval gate applies
// before the tenant is usable (rev2 Z-1). Deleted tenants keep a `revoked`
// tombstone, so a re-login can never mint a second tenant (rev2 S1).
//
// The env-owner fallback lives in lib/auth-adapter.ts (backward compatible
// during expansion); this module handles only DB-backed tenants. It is
// fail-closed: no DB, unknown domain, or non-active status yields null.

export type TenantRow = { user_id: string; role: string; status: string };

export type TenantPolicy = {
  allowedDomains: string[]; // e.g. ["gmail.com","hotmail.com","outlook.com"]
  adminEmails: string[];    // exact admin emails (active immediately)
};

export type TenantIdentity = { idpIss: string; idpSub: string; email: string };
export type ResolvedTenant = { userId: string; role: "learner" | "admin"; status: string };

export type TenantPrepared = {
  bind(...values: unknown[]): TenantPrepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
};
export type TenantDb = { prepare(sql: string): TenantPrepared };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

function asTenantRole(role: string): "learner" | "admin" {
  return role === "admin" ? "admin" : "learner";
}

/**
 * Resolve (or provision) the tenant for a verified human identity.
 * Returns null when: no DB, malformed identity, disallowed domain, or missing
 * row that cannot be provisioned. Never returns another tenant's row: the
 * lookup is keyed on the verified (iss, sub).
 */
export async function resolveTenant(
  db: TenantDb | null | undefined,
  identity: TenantIdentity,
  policy: TenantPolicy,
  now: number,
): Promise<ResolvedTenant | null> {
  const email = normalizeEmail(identity.email);
  const iss = identity.idpIss?.trim();
  const sub = identity.idpSub?.trim();
  if (!db || !email || !iss || !sub) return null;

  const existing = await db
    .prepare("SELECT user_id, role, status, email_normalized FROM users WHERE idp_iss=? AND idp_sub=?")
    .bind(iss, sub)
    .first<TenantRow & { email_normalized?: string }>();
  if (existing) {
    // G15 (MT-2): email is a mutable verified attribute, not the identity key.
    // If the IdP reports a new email, update it best-effort. A unique conflict
    // (another tenant already uses that email) must NOT break login or mint a new
    // tenant — keep the stored email; surface the conflict via an explicit change API.
    if (existing.email_normalized && existing.email_normalized !== email) {
      try {
        await db.prepare("UPDATE users SET email_normalized=?, updated_at=? WHERE user_id=? AND email_normalized=?")
          .bind(email, now, existing.user_id, existing.email_normalized).run();
      } catch { /* email_in_use: keep stored email; do not fail login */ }
    }
    return { userId: existing.user_id, role: asTenantRole(existing.role), status: existing.status };
  }

  // Provision only for allowed domains or explicit admin emails.
  const admins = policy.adminEmails.map(normalizeEmail);
  const isAdmin = admins.includes(email);
  const allowed = isAdmin || policy.allowedDomains.includes(emailDomain(email));
  if (!allowed) return null;

  const userId = crypto.randomUUID();
  const role: "learner" | "admin" = isAdmin ? "admin" : "learner";
  // Admins (owner) are active immediately; everyone else starts pending (Z-1).
  const status = isAdmin ? "active" : "pending";
  await db
    .prepare(
      "INSERT INTO users (user_id, idp_iss, idp_sub, email_normalized, role, status, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(idp_iss, idp_sub) DO NOTHING",
    )
    .bind(userId, iss, sub, email, role, status, now, now)
    .run();

  // Race-safe re-read: a concurrent first login may have won the INSERT.
  const saved = await db
    .prepare("SELECT user_id, role, status FROM users WHERE idp_iss=? AND idp_sub=?")
    .bind(iss, sub)
    .first<TenantRow>();
  if (!saved) return null;
  return { userId: saved.user_id, role: asTenantRole(saved.role), status: saved.status };
}

/** Scope is learner only for an active tenant; pending/suspended/revoked → null. */
export function scopeForTenant(tenant: ResolvedTenant | null): "learner" | null {
  return tenant && tenant.status === "active" ? "learner" : null;
}