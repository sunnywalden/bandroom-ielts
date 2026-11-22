import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { asTenantId, tenantD1 } from "../lib/tenant-db";
import * as schema from "./schema";

function binding() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return env.DB;
}

/**
 * Unscoped Drizzle client. Intended for reviewed service/cross-tenant paths
 * ONLY (see scripts/tenant-db-allowlist.mjs); learner-facing data access must
 * use getTenantDb() so the tripwire runs.
 */
export function getDb() {
  return drizzle(binding(), { schema });
}

/**
 * Tenant-scoped Drizzle client (MT-5 / rev3.1 S4). Every statement the query
 * builder prepares — and every statement in `$client.batch(...)` — is checked
 * by assertTenantPredicate before it reaches D1. The tenant id must come from
 * the authenticated session.
 */
export function getTenantDb(userId: string) {
  return drizzle(tenantD1(binding(), asTenantId(userId)), { schema });
}

/**
 * Drizzle client over an explicit D1 binding, for the few reviewed paths that
 * run BEFORE a tenant is known or deliberately span tenants (PAT resolution by
 * token hash, the runner queue). Learner-facing code must use getTenantDb().
 * Keeping construction here is what lets the ESLint guard forbid importing
 * `drizzle-orm/d1` elsewhere.
 */
export function drizzleFromBinding(binding: unknown) {
  return drizzle(binding as never, { schema });
}
