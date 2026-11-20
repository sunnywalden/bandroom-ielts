// Offline migration export (rev2 S4). The Worker no longer exposes an HTTP
// /api/migrate route; this server-only module holds the one-time full-table
// export logic so an OFFLINE script (with a dedicated, audited D1/R2 credential)
// can produce the same snapshot the pre-cutover migration consumes. Never route
// this through a tenant-facing HTTP handler.
//
// Read-only: it never writes D1 or R2.

export const MIGRATION_TABLES = [
  { name: "learner_states", columns: ["user_id", "revision", "state"], orderBy: "user_id" },
  { name: "teacher_feedback", columns: ["id", "user_id", "day", "stage", "attempt", "evidence", "feedback", "pronunciation", "review_task_id", "analysis_json", "created_at"], orderBy: "id" },
  { name: "teacher_lessons", columns: ["user_id", "day", "lesson"], orderBy: "user_id, day" },
  { name: "review_jobs", columns: ["id", "user_id", "day", "submission_key", "request_hash", "revision", "snapshot", "created_at"], orderBy: "id" },
  { name: "review_tasks", columns: ["id", "review_job_id", "user_id", "kind", "attempt_id", "day", "attempt_revision", "recording_id", "stage", "state", "fence", "attempts", "claim_kind", "manual_grant_sha256", "notification_epoch", "retry_epoch", "claimed_client_run_id", "lease_until", "next_at", "analysis_version", "checkpoint_sha256", "coverage", "last_error", "receipt_id", "claimed_by", "created_at", "updated_at"], orderBy: "id" },
  { name: "review_receipts", columns: ["id", "task_id", "user_id", "attempt_id", "attempt_revision", "recording_sha256", "analysis_version", "fence", "feedback_id", "output_sha256", "output_sha256_v2", "payload_json", "created_at"], orderBy: "id" },
  { name: "analysis_artifacts", columns: ["task_id", "stage", "chunk_index", "analyzer_version", "input_sha256", "artifact_sha256", "bytes", "object_ref", "payload_json", "created_at"], orderBy: "task_id, stage, chunk_index, analyzer_version" },
  { name: "analysis_events", columns: ["id", "at", "task_id", "fence", "event", "stage", "outcome", "client_run_id", "request_id", "metadata_json", "user_id"], orderBy: "id" },
  { name: "scheduler_heartbeats", columns: ["automation_id", "owner_user_id", "generation", "client_run_id", "started_at", "finished_at", "last_success_at", "next_expected_at", "status", "detail"], orderBy: "automation_id" },
  { name: "automation_heartbeats", columns: ["user_id", "automation_id", "generation", "client_run_id", "started_at", "finished_at", "last_success_at", "next_expected_at", "status", "detail"], orderBy: "user_id, automation_id" },
] as const;

export type TableExport = { columns: readonly string[]; rows: Record<string, unknown>[]; count: number };

// Structural types keep this module usable from Node (offline script) and the
// Worker without importing Workers-only globals.
type Db = { prepare(sql: string): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> } };
type Bucket = {
  list(options: { limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number; etag: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
};

async function exportTable(db: Db, spec: (typeof MIGRATION_TABLES)[number]): Promise<TableExport> {
  const query = `SELECT ${spec.columns.join(", ")} FROM ${spec.name} ORDER BY ${spec.orderBy}`;
  const result = await db.prepare(query).all<Record<string, unknown>>();
  const rows = (result.results ?? []) as Record<string, unknown>[];
  return { columns: spec.columns, rows, count: rows.length };
}

async function listObjects(bucket: Bucket) {
  const objects: Array<{ key: string; size: number; etag: string }> = [];
  let cursor: string | undefined;
  for (;;) {
    const options: { limit?: number; cursor?: string } = { limit: 1000 };
    if (cursor) options.cursor = cursor;
    const listed = await bucket.list(options);
    for (const object of listed.objects) objects.push({ key: object.key, size: object.size, etag: object.etag });
    if (!listed.truncated) break;
    if (!listed.cursor) throw new Error("R2 listing was truncated without a cursor.");
    cursor = listed.cursor;
  }
  return objects;
}

export async function exportMigrationSnapshot(db: Db, bucket: Bucket) {
  const tables: Record<string, TableExport> = {};
  for (const spec of MIGRATION_TABLES) tables[spec.name] = await exportTable(db, spec);
  const objects = await listObjects(bucket);
  const createdAt = new Date().toISOString();
  return {
    format: "bandroom.migration-export.v1" as const,
    createdAt,
    purpose: "One-time full-table export for the pre-cutover migration (design D-11 branch B). Do not use as a routine backup.",
    notices: [
      "Contains all ten D1 tables, including runtime and evidence rows, plus an R2 object inventory.",
      "The four learner tables are also recoverable through backup v3; the six runtime/evidence tables require scripts/migrate/export-import.mjs.",
      "Recording SHA-256 values come from the signed backup manifest, not from R2 listing metadata.",
      "Multi-tenant: run this offline with a dedicated migration credential; there is no HTTP export surface.",
    ],
    tables,
    r2: { count: objects.length, objects },
  };
}