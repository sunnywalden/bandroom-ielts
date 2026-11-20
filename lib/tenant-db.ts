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

// Strip SQL comments and single-quoted string literals before analysis so a
// comment/literal cannot smuggle a table name or a bare `user_id` token past the
// tripwire. NOT a parser: this remains heuristic (see module header) and is not
// a security boundary. A SQL AST dependency is the complete fix.
export function stripSql(sql: string): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/--[^\n]*/g, " ");
  s = s.replace(/'(?:[^']|'')*'/g, "''");
  return s;
}
const IDENT = String.raw`(?:\w+\.)?(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`;
const TABLE_REF = new RegExp(String.raw`\b(?:from|join|into|update)\s+(${IDENT})`, "gi");
const FROM_LIST = /\bfrom\s+([^;]*?)(?=\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bjoin\b|\bon\b|$)/gi;
const HAS_TENANT_PREDICATE = /\b(?:\w+\.)?user_id\b\s*(?:=|\bin\b|\blike\b)/i;
// Server-side attribution: an INSERT that derives user_id from the referenced
// task, e.g. `(SELECT user_id FROM review_tasks WHERE id=?)`.
const HAS_TENANT_SUBQUERY = /\(\s*select\s+user_id\s+from\s+review_tasks\b/i;

function unquoteId(token: string): string {
  let t = token;
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  return t.replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
}
function collect(sql: string, direct: Set<string>, indirect: Set<string>) {
  const consider = (raw: string) => {
    const name = unquoteId(raw);
    if (TENANT_TABLES.has(name)) direct.add(name);
    else if (INDIRECT_TABLES.has(name)) indirect.add(name);
  };
  for (const m of sql.matchAll(TABLE_REF)) consider(m[1]);
  // Comma-separated FROM lists (FROM a, b, c).
  for (const m of sql.matchAll(FROM_LIST)) {
    for (const part of m[1].split(",")) {
      const first = part.trim().match(new RegExp(String.raw`^(${IDENT})`));
      if (first) consider(first[1]);
    }
  }
}

/** Return the tenant tables a statement references (direct and indirect). */
export function referencedTenantTables(sql: string): { direct: string[]; indirect: string[] } {
  const direct = new Set<string>();
  const indirect = new Set<string>();
  collect(stripSql(sql), direct, indirect);
  return { direct: [...direct], indirect: [...indirect] };
}

/**
 * Tripwire: throw when a statement touches tenant data without a user_id
 * comparison predicate (in a WHERE/ON clause), or references analysis_artifacts
 * without review_tasks. Failure modes:
 *  - a bare `user_id` token only (projection/comment/string) does NOT pass;
 *  - a statement with no WHERE/ON does NOT pass;
 *  - comments/strings/quoted or schema-qualified identifiers are handled.
 * Known residual gap: it cannot prove join semantics (e.g. a LEFT JOIN from the
 * artifact side). Treat it as an early warning, NOT a boundary.
 */
export function assertTenantPredicate(sql: string): void {
  const s = stripSql(sql);
  const { direct, indirect } = referencedTenantTables(sql);
  if (!direct.length && !indirect.length) return;
  const hasClause = /\b(where|on)\b/i.test(s);
  const scoped = hasClause && (HAS_TENANT_PREDICATE.test(s) || HAS_TENANT_SUBQUERY.test(s));
  if (direct.length && !scoped) {
    throw new Error(`tenant_query_missing_user_id: ${direct.join(",")} :: ${sql.slice(0, 120)}`);
  }
  if (indirect.length && (!/\breview_tasks\b/i.test(s) || !scoped)) {
    throw new Error(`tenant_query_unscoped_artifact: ${sql.slice(0, 120)}`);
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