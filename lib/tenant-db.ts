// Typed tenant boundary (rev2 S11). Soft isolation is enforced today by every
// query carrying `user_id`. This module adds a *tripwire* so a new raw query
// that targets a tenant table without any `user_id` predicate fails loudly, and
// brands the tenant id so only an authenticated value can reach the data layer.
//
// IMPORTANT: assertTenantPredicate is a heuristic tripwire, NOT a proof — it
// cannot see dead `user_id` tokens or fully model joins. The substantive control
// remains the write-side cross-tenant integration tests (tests/tenant-isolation).
// New data-access code should go through tenantScoped() so the tripwire runs.

export type TenantId = string & { readonly __brand: "TenantId" };

/** Brand a value that came from the authenticated session as a TenantId. */
export function asTenantId(value: unknown): TenantId {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid_tenant_id");
  return value as TenantId;
}

// Tables that hold per-tenant rows and MUST be filtered by user_id.
export const TENANT_TABLES = new Set([
  "learner_states", "teacher_feedback", "teacher_lessons", "review_jobs",
  "review_tasks", "review_receipts", "analysis_events", "automation_heartbeats",
  "personal_calibration", "calibration_candidates", "calibration_events",
  "users", "user_cost_ledger",
]);
// Indirectly isolated: protected by joining review_tasks on user_id.
const INDIRECT_TABLES = new Set(["analysis_artifacts"]);

const TABLE_REF = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/gi;

/**
 * Return the tenant tables a statement references. Only the first relation after
 * FROM/JOIN/INTO/UPDATE is considered, which is enough for this codebase's
 * single-hop queries; nested/derived relations are still caught because their
 * inner FROM is scanned too.
 */
export function referencedTenantTables(sql: string): { direct: string[]; indirect: string[] } {
  const direct = new Set<string>();
  const indirect = new Set<string>();
  for (const match of sql.matchAll(TABLE_REF)) {
    const name = match[1].toLowerCase();
    if (TENANT_TABLES.has(name)) direct.add(name);
    else if (INDIRECT_TABLES.has(name)) indirect.add(name);
  }
  return { direct: [...direct], indirect: [...indirect] };
}

/**
 * Throw when a statement touches tenant data without a `user_id` predicate.
 * A statement that references an indirect table must also join review_tasks.
 */
export function assertTenantPredicate(sql: string): void {
  const { direct, indirect } = referencedTenantTables(sql);
  if (!direct.length && !indirect.length) return;
  const hasUser = /\buser_id\b/i.test(sql);
  if (direct.length && !hasUser) {
    throw new Error(`tenant_query_missing_user_id: ${direct.join(",")} :: ${sql.slice(0, 120)}`);
  }
  if (indirect.length) {
    const joinsTasks = /\breview_tasks\b/i.test(sql) && hasUser;
    if (!joinsTasks) {
      throw new Error(`tenant_query_unscoped_artifact: ${sql.slice(0, 120)}`);
    }
  }
}

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};
type RawDb = { prepare(sql: string): Prepared };

/**
 * A tenant-bound view of a D1-like database: every prepare() runs the tripwire
 * before returning the statement, and the tenant id is only accepted as a
 * branded TenantId. Use this for NEW data-access code.
 */
export function tenantScoped(db: RawDb, tenant: TenantId): {
  tenant: TenantId;
  prepare(sql: string): Prepared;
} {
  if (!tenant) throw new Error("tenant_required");
  return {
    tenant,
    prepare(sql: string): Prepared {
      assertTenantPredicate(sql);
      return db.prepare(sql);
    },
  };
}