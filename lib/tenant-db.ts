// Typed tenant boundary (rev2 S11 / MT-5 rev3.1 S4+G1). Soft isolation is
// enforced today by every query carrying `user_id`. This module adds a
// *tripwire* so a new raw query that targets a tenant table without any
// `user_id` predicate fails loudly, and brands the tenant id so only an
// authenticated value can reach the data layer.
//
// IMPORTANT: assertTenantPredicate is a heuristic tripwire, NOT a proof and NOT
// a security boundary. The checks below recognise the common bypass shapes
// (self-comparison, always-true OR, set operations, ON 1=1) by pattern, not by
// parsing SQL. It cannot see a value that was computed elsewhere, cannot resolve
// dynamic SQL assembled at runtime, and a determined author can write novel SQL
// that still slips through. The substantive controls remain the write-side
// cross-tenant integration tests (tests/tenant-isolation) plus code review.
// New data-access code should go through tenantScoped() / scopedTenantDb()
// (lib/tenant-repository.ts) so the tripwire at least runs.
//
// REVIEWED CROSS-TENANT / SERVICE EXCEPTIONS (intentionally NOT tripwire
// failures; keep this list small and reviewed):
//  - lib/review-tasks.ts claimNextReviewTask / markExhaustedGlobal /
//    hasOtherDueTasks: the runner queue deliberately selects across tenants and
//    derives the tenant from the claimed row.
//  - lib/service-audit.ts: service-identity audit rows are attributed only by a
//    verified task lease; unverified calls are written with userId=null.
//  - lib/admin.ts + app/api/admin/*: admin aggregates/queue views are
//    content-blind counts and identity metadata.
//  - lib/metrics.ts: scheduled tenant_metrics_daily aggregation is cross-tenant
//    and content-blind by design.
//  - lib/migrate-export.ts: offline, dedicated-credential full-table export;
//    there is no HTTP route.
//  - lib/dsr.ts / app/api/admin/dsr: admin/service DSR jobs keyed by an explicit
//    admin-supplied userId/jobId; audit anonymisation is cross-tenant by design.
//  - lib/retention.ts: age-based audit anonymisation intentionally strips
//    attribution across tenants.
//  - lib/tenant-identity.ts: login resolves an IdP subject to a tenant before a
//    tenant id exists, so it cannot carry a user_id predicate.
// These exceptions are enforced by tests/tenant-access-guard.test.mjs.

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
  "users", "user_cost_ledger", "user_tokens", "consent_events", "dsr_jobs",
  "user_usage_daily", "tenant_metrics_daily", "user_entitlements",
]);
// Indirectly isolated: protected by joining review_tasks on user_id.
const INDIRECT_TABLES = new Set(["analysis_artifacts"]);

// Strip SQL comments and single-quoted string literals before analysis so a
// comment/literal cannot smuggle a table name or a bare `user_id` token past the
// tripwire. NOT a parser: this remains heuristic (see module header) and is not
// a security boundary. A SQL AST dependency is the complete fix.
export function stripSql(sql: string): string {
  // Single left-to-right pass that respects string-literal boundaries, so a
  // comment marker inside a quoted string cannot delete following SQL.
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      out += "''";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i++; break; }
        else i++;
      }
    } else if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
    } else if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
const IDENT = String.raw`(?:\w+\.)?(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`;
const TABLE_REF = new RegExp(String.raw`\b(?:from|join|into|update)\s+(${IDENT})`, "gi");
const FROM_LIST = /\bfrom\s+([^;]*?)(?=\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bjoin\b|\bon\b|$)/gi;
const HAS_TENANT_PREDICATE = /\b(?:\w+\.)?user_id\b\s*(?:=|\bin\b|\blike\b)/i;
// Server-side attribution: an INSERT that derives user_id from the referenced
// task, e.g. `(SELECT user_id FROM review_tasks WHERE id=?)`.
const HAS_TENANT_SUBQUERY = /\(\s*select\s+user_id\s+from\s+review_tasks\b/i;

// --- Heuristic bypass guards -------------------------------------------------
// These are patterns, not a SQL parser. They close the shapes a security review
// demonstrated (`user_id=user_id`, `OR 1=1`, `ON 1=1`, `UNION ... SELECT`), but
// a novel statement can still evade them. See the module header.
const USER_ID_COL = String.raw`(?:"user_id"|` + "`user_id`" + String.raw`|\[user_id\]|\buser_id\b)`;
// `user_id=user_id` or `t.user_id = t.user_id` compares a column to itself and
// is always true. Cross-alias joins such as `l.user_id = t.user_id` are NOT
// tautologies (the qualifiers differ), so they are left alone.
const SELF_COMPARISON = new RegExp(
  String.raw`(?:(\w+)\.)?${USER_ID_COL}\s*=\s*(?:(\w+)\.)?${USER_ID_COL}`,
  "gi",
);
// `OR TRUE`, `OR 1=1`, `OR '1'='1'` (stripSql folds string literals to `''`),
// `OR NULL IS NULL`: an always-true disjunct defeats the tenant predicate.
const ALWAYS_TRUE_DISJUNCTION =
  /\bor\b\s*\(?\s*(?:true\b|1\s*=\s*1\b|null\s+is\s+null\b|''\s*=\s*''|""\s*=\s*"")/i;
// `JOIN ... ON 1=1` / `ON true` is an unrestricted cross join regardless of a
// WHERE predicate on one side.
const ALWAYS_TRUE_JOIN = /\bon\b\s*\(?\s*(?:1\s*=\s*1\b|true\b|''\s*=\s*'')\s*\)?/i;
// A set operation combines rows from every branch; a predicate in one branch
// does not scope the others.
const SET_OPERATION = /\b(?:union(?:\s+all)?|intersect|except)\b/i;

function hasSelfComparison(sql: string): boolean {
  for (const match of sql.matchAll(SELF_COMPARISON)) {
    if ((match[1] ?? "").toLowerCase() === (match[2] ?? "").toLowerCase()) return true;
  }
  return false;
}

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
 *  - self-comparison (`user_id=user_id`), an always-true disjunction
 *    (`OR 1=1`, `OR true`, `OR '1'='1'`), a set operation
 *    (`UNION [ALL]`/`INTERSECT`/`EXCEPT`) and a cross join (`ON 1=1`/`ON true`)
 *    are rejected outright;
 *  - comments/strings/quoted or schema-qualified identifiers are handled.
 * These are heuristic guards, NOT a SQL parser or a proof. A statement can still
 * evade them (e.g. runtime-assembled SQL or an unusual always-true expression),
 * so the write-side matrix and review remain the authoritative control.
 * Known residual gap: it cannot prove join semantics (e.g. a LEFT JOIN from the
 * artifact side). Treat it as an early warning, NOT a boundary.
 */
export function assertTenantPredicate(sql: string): void {
  const s = stripSql(sql);
  const { direct, indirect } = referencedTenantTables(sql);
  if (!direct.length && !indirect.length) return;
  if (hasSelfComparison(s)) {
    throw new Error(`tenant_query_tautology: ${[...direct, ...indirect].join(",")} :: ${sql.slice(0, 120)}`);
  }
  if (ALWAYS_TRUE_DISJUNCTION.test(s)) {
    throw new Error(`tenant_query_always_true: ${[...direct, ...indirect].join(",")} :: ${sql.slice(0, 120)}`);
  }
  if (ALWAYS_TRUE_JOIN.test(s)) {
    throw new Error(`tenant_query_cross_join: ${[...direct, ...indirect].join(",")} :: ${sql.slice(0, 120)}`);
  }
  if (SET_OPERATION.test(s)) {
    throw new Error(`tenant_query_set_operation: ${[...direct, ...indirect].join(",")} :: ${sql.slice(0, 120)}`);
  }
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