// Files allowed to import the unscoped Drizzle client (`getDb`) from `@/db`.
//
// Every learner-facing data path must use getTenantDb(userId) so the tripwire
// (lib/tenant-db.ts) runs before the statement reaches SQLite. The files below
// are reviewed service / cross-tenant paths whose rationale is documented in
// the lib/tenant-db.ts header. Keep this list small; adding an entry is a
// reviewed decision, not a lint workaround.
//
// Enforced by:
//  - eslint.config.mjs (no-restricted-imports for `getDb` / `drizzle-orm/d1`)
//  - tests/tenant-access-guard.test.mjs ("only reviewed files import getDb")
//
// Paths are repo-relative POSIX paths.
export const TENANT_DB_ALLOWLIST = [
  {
    file: "lib/review-tasks.ts",
    reason: "runner queue (claimNextReviewTask) deliberately claims across tenants and derives the tenant from the claimed row",
  },
  {
    file: "lib/service-audit.ts",
    reason: "service-identity audit rows are attributed only by a verified task lease; unverified calls write userId=null",
  },
  {
    file: "app/api/dsr/route.ts",
    reason: "DSR jobs are service rows keyed by an explicit authenticated userId/jobId; audit anonymisation is cross-tenant",
  },
  {
    file: "app/api/admin/breakglass/route.ts",
    reason: "admin break-glass operations act on an explicitly targeted tenant",
  },
  {
    file: "app/api/admin/cost/route.ts",
    reason: "admin cost view is a cross-tenant, content-blind aggregate",
  },
  {
    file: "app/api/admin/dsr/route.ts",
    reason: "admin DSR queue acts on explicitly targeted jobs, cross-tenant by design",
  },
  {
    file: "app/api/admin/entitlements/route.ts",
    reason: "admin entitlement grant/revoke targets an explicitly supplied tenant",
  },
  {
    file: "app/api/admin/invites/route.ts",
    reason: "admin invite issuance resolves an IdP subject to a tenant before a tenant id exists",
  },
  {
    file: "app/api/admin/metrics/route.ts",
    reason: "admin metrics view is a cross-tenant, content-blind aggregate",
  },
  {
    file: "app/api/admin/publish-lesson/route.ts",
    reason: "admin publishes a lesson for an explicitly targeted tenant",
  },
  {
    file: "app/api/admin/queue/route.ts",
    reason: "admin queue view is a cross-tenant, content-blind aggregate",
  },
  {
    file: "app/api/admin/tokens/route.ts",
    reason: "admin PAT management targets an explicitly supplied tenant",
  },
  {
    file: "app/api/admin/users/[id]/route.ts",
    reason: "admin user detail/status changes target an explicitly supplied tenant",
  },
  {
    file: "app/api/admin/users/route.ts",
    reason: "admin user listing is identity metadata across tenants",
  },
];

export const TENANT_DB_ALLOWLIST_FILES = new Set(TENANT_DB_ALLOWLIST.map(entry => entry.file));
