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
  fence: integer("fence"),
  event: text("event").notNull(),
  stage: text("stage"),
  outcome: text("outcome").notNull(),
  clientRunId: text("client_run_id"),
  requestId: text("request_id"),
  metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown>>(),
}, table => [index("analysis_events_task").on(table.taskId, table.at)]);
