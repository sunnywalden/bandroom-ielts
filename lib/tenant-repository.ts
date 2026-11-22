// Scoped repository helpers for NEW raw-D1 data access (MT-5 / rev3.1 S4+G1).
//
// Use these helpers instead of calling a raw D1 binding directly:
//
//   const db = scopedTenantDb(env.DB, asTenantId(session.user.userId));
//   await db.prepare("SELECT ... FROM learner_states WHERE user_id=?").bind(tenant).all();
//
// Every prepare() runs assertTenantPredicate first, so a statement that names a
// tenant table without a user_id predicate fails before it reaches SQLite. The
// tenant id must be a branded TenantId (asTenantId) so only a value that came
// from the authenticated session can be passed.
//
// IMPORTANT: this is defence-in-depth. The tripwire is heuristic, not a SQL
// parser (see lib/tenant-db.ts); a novel statement can still evade it. The
// authoritative controls remain the write-side cross-tenant matrix
// (tests/tenant-isolation) and code review.
//
// Drizzle query-builder code reaches D1 through getTenantDb(userId) (db/index.ts),
// which wraps the binding so every prepared statement — including each entry of
// $client.batch(...) — runs the same tripwire (MT-5 S4 closure). Files that keep
// the unscoped getDb() client are reviewed service/cross-tenant paths listed in
// scripts/tenant-db-allowlist.mjs and enforced by ESLint plus the static guard
// test. reviewTaskDb() deliberately stays unwrapped: the live runner queue
// claims across tenants (claimNextReviewTask) and derives the tenant from the
// claimed row.

import { asTenantId, assertTenantPredicate, type TenantId } from "./tenant-db.ts";

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

type RawD1 = { prepare(sql: string): Prepared };

/**
 * Assert the tripwire for `sql`, then prepare it on `rawDb`. The tenant id is
 * validated (branded value, non-empty) but is not bound automatically; callers
 * still bind it as the `user_id` argument.
 */
export function tenantPrepare<T extends Prepared = Prepared>(
  rawDb: RawD1,
  tenantId: TenantId,
  sql: string,
): T {
  // Re-validate at runtime: the TenantId brand is a compile-time hint, and a
  // crafted empty value must never reach the data layer.
  asTenantId(tenantId);
  assertTenantPredicate(sql);
  return rawDb.prepare(sql) as T;
}

/**
 * A tenant-bound view of a raw D1-like database. `prepare` asserts the
 * tripwire before returning the statement; `tenant` is the branded id accepted
 * by the factory. Use this for NEW raw-SQL data access.
 */
export function scopedTenantDb(rawDb: RawD1, tenantId: TenantId): {
  tenant: TenantId;
  prepare<T extends Prepared = Prepared>(sql: string): T;
  tenantPrepare<T extends Prepared = Prepared>(sql: string): T;
} {
  const tenant = asTenantId(tenantId);
  return {
    tenant,
    prepare<T extends Prepared = Prepared>(sql: string): T {
      assertTenantPredicate(sql);
      return rawDb.prepare(sql) as T;
    },
    tenantPrepare<T extends Prepared = Prepared>(sql: string): T {
      return tenantPrepare<T>(rawDb, tenant, sql);
    },
  };
}