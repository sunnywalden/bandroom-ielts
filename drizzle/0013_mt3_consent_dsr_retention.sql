-- MT-3 (design rev3.1 §4.7): versioned consent trail, resumable DSR jobs, and
-- retention policy. Additive; existing rows unchanged. users.consent_version /
-- consent_at (0008) remain the current-consent snapshot.

-- Append-only consent events. A withdrawal sets withdrawn_at; the current
-- snapshot on users is updated transactionally. Never stores consent text body.
CREATE TABLE IF NOT EXISTS `consent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`version` text NOT NULL,
	`purpose` text NOT NULL,
	`at` integer NOT NULL,
	`withdrawn_at` integer,
	`ip_hash` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `consent_events_user` ON `consent_events` (`user_id`,`at`);
--> statement-breakpoint

-- Resumable DSR export/delete jobs (F8). cursor_json tracks per-table/per-prefix
-- progress so a partial failure can continue. manifest_json records counts.
CREATE TABLE IF NOT EXISTS `dsr_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`cursor_json` text,
	`manifest_json` text,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dsr_jobs_user` ON `dsr_jobs` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dsr_jobs_status` ON `dsr_jobs` (`status`,`updated_at`);
--> statement-breakpoint

-- Retention policy per data class (days). Seeded by the application; the
-- scheduled handler reads it to purge expired R2 objects / D1 rows.
CREATE TABLE IF NOT EXISTS `retention_policy` (
	`data_class` text PRIMARY KEY NOT NULL,
	`retention_days` integer NOT NULL,
	`action` text NOT NULL,
	`updated_at` integer NOT NULL
);