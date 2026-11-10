CREATE TABLE `analysis_artifacts` (
	`task_id` text NOT NULL,
	`stage` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`analyzer_version` text NOT NULL,
	`input_sha256` text NOT NULL,
	`artifact_sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`object_ref` text,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `stage`, `chunk_index`, `analyzer_version`)
);
--> statement-breakpoint
CREATE TABLE `analysis_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`task_id` text,
	`fence` integer,
	`event` text NOT NULL,
	`stage` text,
	`outcome` text NOT NULL,
	`client_run_id` text,
	`request_id` text,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `analysis_events_task` ON `analysis_events` (`task_id`,`at`);--> statement-breakpoint
CREATE TABLE `review_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`attempt_revision` integer NOT NULL,
	`recording_sha256` text,
	`analysis_version` text,
	`fence` integer NOT NULL,
	`feedback_id` text NOT NULL,
	`output_sha256` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_receipts_task` ON `review_receipts` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_receipts_attempt` ON `review_receipts` (`user_id`,`attempt_id`,`attempt_revision`);--> statement-breakpoint
CREATE TABLE `review_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`review_job_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`attempt_id` text NOT NULL,
	`day` integer NOT NULL,
	`attempt_revision` integer NOT NULL,
	`recording_id` text,
	`stage` text DEFAULT 'read_input' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`next_at` integer NOT NULL,
	`analysis_version` text,
	`checkpoint_sha256` text,
	`coverage` real,
	`last_error` text,
	`receipt_id` text,
	`claimed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_tasks_job` ON `review_tasks` (`review_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_tasks_attempt` ON `review_tasks` (`user_id`,`attempt_id`);--> statement-breakpoint
CREATE INDEX `review_tasks_due` ON `review_tasks` (`user_id`,`state`,`next_at`,`id`);--> statement-breakpoint
CREATE TABLE `scheduler_heartbeats` (
	`automation_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`client_run_id` text,
	`started_at` integer,
	`finished_at` integer,
	`last_success_at` integer,
	`next_expected_at` integer,
	`status` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
ALTER TABLE `teacher_feedback` ADD `review_task_id` text;--> statement-breakpoint
ALTER TABLE `teacher_feedback` ADD `analysis_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `teacher_feedback_review_task` ON `teacher_feedback` (`review_task_id`);