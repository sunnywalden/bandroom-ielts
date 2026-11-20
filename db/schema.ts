import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const learnerStates = sqliteTable("learner_states", {
  userId: text("user_id").primaryKey(),
  revision: integer("revision").notNull(),
  state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

export const teacherLessons = sqliteTable("teacher_lessons", {
  userId: text("user_id").notNull(),
  day: integer("day").notNull(),
  lesson: text("lesson", { mode: "json" }).$type<import("@/app/curriculum").Lesson>().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.day] })]);

export const teacherFeedback = sqliteTable("teacher_feedback", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  day: integer("day").notNull(),
  stage: text("stage").notNull(),
  attempt: text("attempt").notNull(),
  evidence: text("evidence").notNull(),
  feedback: text("feedback").notNull(),
  pronunciation:text("pronunciation",{mode:"json"}).$type<{
    band:number;recordingId:string;reviewedWholeClip:true;observation:string;scope:"partial"
  }>(),
  // Automatic review task receipt binding. Null for historic/manual reviews.
  reviewTaskId: text("review_task_id"),
  analysisJson: text("analysis_json", { mode: "json" }).$type<Record<string, unknown>>(),
  // S3.1 (MT-2): author provenance. 'learner-note' | 'coach' | 'coach-runner'.
  // Learner self-notes cannot carry pronunciation/analysis/candidates.
  authorScope: text("author_scope").notNull().default("coach"),
  createdAt: text("created_at").notNull(),
}, table => [
  index("teacher_feedback_user_day").on(table.userId, table.day),
  uniqueIndex("teacher_feedback_review_task").on(table.reviewTaskId),
]);

export const reviewJobs = sqliteTable("review_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  day: integer("day").notNull(),
  submissionKey: text("submission_key").notNull(),
  requestHash: text("request_hash").notNull(),
  revision: integer("revision").notNull(),
  snapshot: text("snapshot", {mode:"json"}).$type<import("@/lib/review-jobs").FrozenReview>().notNull(),
  createdAt: text("created_at").notNull(),
}, table => [
  uniqueIndex("review_jobs_submission").on(table.userId, table.submissionKey),
  index("review_jobs_user_day").on(table.userId, table.day),
]);

// Mutable processing state. `review_jobs` remains the immutable submission snapshot.
export const reviewTasks = sqliteTable("review_tasks", {
  id: text("id").primaryKey(),
  reviewJobId: text("review_job_id").notNull(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(), // 'text' | 'speaking'
  attemptId: text("attempt_id").notNull(),
  day: integer("day").notNull(),
  attemptRevision: integer("attempt_revision").notNull(),
  recordingId: text("recording_id"),
  stage: text("stage").notNull().default("read_input"),
  state: text("state").notNull().default("queued"),
  fence: integer("fence").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  claimKind: text("claim_kind").notNull().default("auto"),
  manualGrantSha256: text("manual_grant_sha256"),
  notificationEpoch: integer("notification_epoch").notNull().default(0),
  retryEpoch: integer("retry_epoch").notNull().default(0),
  claimedClientRunId: text("claimed_client_run_id"),
  leaseUntil: integer("lease_until"),
  nextAt: integer("next_at").notNull(),
  analysisVersion: text("analysis_version"),
  checkpointSha256: text("checkpoint_sha256"),
  coverage: real("coverage"),
  lastError: text("last_error"),
  receiptId: text("receipt_id"),
  claimedBy: text("claimed_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  uniqueIndex("review_tasks_job").on(table.reviewJobId),
  uniqueIndex("review_tasks_attempt").on(table.userId, table.attemptId),
  index("review_tasks_due").on(table.userId, table.state, table.nextAt, table.id),
  // Cross-tenant runner claim (rev2 §7): the claim-any query cannot use the
  // per-user due index, so it gets its own (state, next_at, id) index.
  index("review_tasks_claim_any").on(table.state, table.nextAt, table.id),
]);

export const analysisArtifacts = sqliteTable("analysis_artifacts", {
  taskId: text("task_id").notNull(),
  stage: text("stage").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  analyzerVersion: text("analyzer_version").notNull(),
  inputSha256: text("input_sha256").notNull(),
  artifactSha256: text("artifact_sha256").notNull(),
  bytes: integer("bytes").notNull(),
  objectRef: text("object_ref"),
  payloadJson: text("payload_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [primaryKey({ columns: [table.taskId, table.stage, table.chunkIndex, table.analyzerVersion] })]);

export const reviewReceipts = sqliteTable("review_receipts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  userId: text("user_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  attemptRevision: integer("attempt_revision").notNull(),
  recordingSha256: text("recording_sha256"),
  analysisVersion: text("analysis_version"),
  fence: integer("fence").notNull(),
  feedbackId: text("feedback_id").notNull(),
  outputSha256: text("output_sha256").notNull(),
  outputSha256V2: text("output_sha256_v2"),
  payloadJson: text("payload_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [
  uniqueIndex("review_receipts_task").on(table.taskId),
  uniqueIndex("review_receipts_attempt").on(table.userId, table.attemptId, table.attemptRevision),
]);

export const schedulerHeartbeats = sqliteTable("scheduler_heartbeats", {
  automationId: text("automation_id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  generation: integer("generation").notNull().default(0),
  clientRunId: text("client_run_id"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  lastSuccessAt: integer("last_success_at"),
  nextExpectedAt: integer("next_expected_at"),
  status: text("status").notNull(),
  detail: text("detail"),
});

// Per-owner heartbeat state. Kept separate from the legacy singleton table so
// v13 can still write scheduler_heartbeats during a rollback.
export const automationHeartbeats = sqliteTable("automation_heartbeats", {
  userId: text("user_id").notNull(),
  automationId: text("automation_id").notNull(),
  generation: integer("generation").notNull().default(0),
  clientRunId: text("client_run_id"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  lastSuccessAt: integer("last_success_at"),
  nextExpectedAt: integer("next_expected_at"),
  status: text("status").notNull(),
  detail: text("detail"),
}, table => [primaryKey({ columns: [table.userId, table.automationId] })]);

// Append-only audit trail. Never store audio, answer text or tokens here.
export const analysisEvents = sqliteTable("analysis_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  taskId: text("task_id"),
  // Tenant attribution (rev2 S10). Nullable for legacy/non-task events; new
  // task-bound events are attributed server-side from review_tasks.user_id.
  userId: text("user_id"),
  fence: integer("fence"),
  event: text("event").notNull(),
  stage: text("stage"),
  outcome: text("outcome").notNull(),
  clientRunId: text("client_run_id"),
  requestId: text("request_id"),
  metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
}, table => [index("analysis_events_task").on(table.taskId, table.at)]);

// Personal pronunciation calibration (design rev2 §8, FIX-15/17/22).
// The three tables are additive: existing tables and their data stay unchanged.
// userId is taken from the authenticated session on write; it is never supplied
// by an MCP client. state is CANDIDATE | TRUSTED | SUPPRESSED. TRUSTED promotion
// is disabled until the V3 gate passes (rev2 §4.2), so this data layer only
// derives CANDIDATE/SUPPRESSED.
export const personalCalibration = sqliteTable("personal_calibration", {
  userId: text("user_id").notNull(),
  expected: text("expected").notNull(),
  actual: text("actual").notNull(),
  nConfirmed: integer("n_confirmed").notNull().default(0),
  nRejected: integer("n_rejected").notNull().default(0),
  nUnsure: integer("n_unsure").notNull().default(0),
  nShown: integer("n_shown").notNull().default(0),
  state: text("state").notNull().default("CANDIDATE"),
  ruleVersion: text("rule_version").notNull(),
  detectorVersion: text("detector_version").notNull(),
  inventoryVersion: text("inventory_version").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.expected, table.actual] }),
  index("personal_calibration_user_state").on(table.userId, table.state),
]);

// Server-issued display record. A verdict can only reference a candidate row
// that this server created for this user, which prevents clients from inventing
// (word, expected, actual, atMs) tuples. Catch trials are canonical correct
// items and are represented by expected === actual; isCatchTrial is derived
// server-side from the stored candidate rather than trusted from the client.
export const calibrationCandidates = sqliteTable("calibration_candidates", {
  candidateId: text("candidate_id").primaryKey(),
  userId: text("user_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  recordingId: text("recording_id").notNull(),
  word: text("word").notNull(),
  expected: text("expected").notNull(),
  actual: text("actual").notNull(),
  atMs: integer("at_ms").notNull(),
  detectorConfidence: real("detector_confidence").notNull(),
  shownAt: integer("shown_at").notNull(),
  answeredAt: integer("answered_at"),
}, table => [
  index("calibration_candidates_user_attempt").on(table.userId, table.attemptId),
]);

// Multi-tenant identity registry (rev2 §2.1). Authoritative identity is the
// IdP (iss, sub) pair; email is a mutable verified attribute. Deleted tenants
// keep a permanent `revoked` tombstone so a re-login cannot mint a new tenant.
// userId is an opaque UUID; it is the tenant key used by every learner table.
export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey(),
  idpIss: text("idp_iss").notNull(),
  idpSub: text("idp_sub").notNull(),
  // Nullable: revocation tombstones clear direct PII (MT-2 S9.3). The IdP
  // (iss, sub) pair remains the permanent identity key.
  emailNormalized: text("email_normalized"),
  displayName: text("display_name"),
  role: text("role").notNull().default("learner"), // 'learner' | 'admin'
  status: text("status").notNull().default("pending"), // pending|active|suspended|revoked
  consentVersion: text("consent_version"),
  consentAt: integer("consent_at"),
  revokedAt: integer("revoked_at"),
  revocationEpoch: integer("revocation_epoch").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  uniqueIndex("users_idp_sub").on(table.idpIss, table.idpSub),
  uniqueIndex("users_email").on(table.emailNormalized),
  index("users_status").on(table.status),
]);

// Per-tenant cost ledger (rev2 §2.4). Integer micro-CNY avoids float drift.
// Rows are pre-created on first reservation; `paused` is per tenant, never global.
export const userCostLedger = sqliteTable("user_cost_ledger", {
  userId: text("user_id").notNull(),
  utcDay: text("utc_day").notNull(),
  spentMicroCny: integer("spent_micro_cny").notNull().default(0),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.utcDay] })]);

// Append-only verdict log. expected/actual are denormalised from the immutable
// candidate so the (user_id, expected, actual) index can serve profile
// recomputation without a join. The unique key is the idempotency contract:
// a retried/double-clicked/replayed verdict cannot double-count.
export const calibrationEvents = sqliteTable("calibration_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  expected: text("expected").notNull(),
  actual: text("actual").notNull(),
  verdict: text("verdict").notNull(),
  isCatchTrial: integer("is_catch_trial", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
}, table => [
  uniqueIndex("calibration_events_candidate").on(table.userId, table.attemptId, table.candidateId),
  index("calibration_events_profile").on(table.userId, table.expected, table.actual),
]);

// MT-2 (design rev3.1 §4.6): append-only admin action log. Never stores learner
// content. break-glass reads are logged synchronously before content returns.
export const adminAudit = sqliteTable("admin_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  action: text("action").notNull(),
  targetUserId: text("target_user_id"),
  reason: text("reason"),
  expiresAt: integer("expires_at"),
  metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
}, table => [
  index("admin_audit_actor").on(table.actorUserId, table.at),
  index("admin_audit_target").on(table.targetUserId, table.at),
]);

// MT-2: invite codes for the approval gate. code stored hashed.
export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  email: text("email"),
  role: text("role").notNull().default("learner"),
  expiresAt: integer("expires_at").notNull(),
  createdBy: text("created_by").notNull(),
  usedAt: integer("used_at"),
  usedBy: text("used_by"),
}, table => [
  uniqueIndex("invites_code_hash").on(table.codeHash),
]);

// MT-2: personal access tokens for learner MCP connectors (MVP; OAuth later).
// Stored hashed; revocable; bound to one tenant.
export const userTokens = sqliteTable("user_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  label: text("label"),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
}, table => [
  uniqueIndex("user_tokens_hash").on(table.tokenHash),
  index("user_tokens_user").on(table.userId),
]);
