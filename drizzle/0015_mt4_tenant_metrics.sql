-- MT-4 (design rev3.1 §4.8, G9/F9): per-tenant daily metrics aggregated from
-- review_tasks / analysis_events / user_cost_ledger by the scheduled handler.
-- No learner content; counts and timings only.
CREATE TABLE IF NOT EXISTS `tenant_metrics_daily` (
	`user_id` text NOT NULL,
	`utc_day` text NOT NULL,
	`queued` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`blocked` integer DEFAULT 0 NOT NULL,
	`needs_attention` integer DEFAULT 0 NOT NULL,
	`cost_micro_cny` integer DEFAULT 0 NOT NULL,
	`audio_bytes` integer DEFAULT 0 NOT NULL,
	`oldest_queued_at` integer,
	`last_active_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `utc_day`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenant_metrics_day` ON `tenant_metrics_daily` (`utc_day`);
--> statement-breakpoint
-- Service-level runner heartbeat (S19): attribution to a service principal,
-- not a single tenant. Nullable user_id keeps the legacy per-owner rows valid.
CREATE TABLE IF NOT EXISTS `service_heartbeats` (
	`service_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`client_run_id` text,
	`started_at` integer,
	`finished_at` integer,
	`last_success_at` integer,
	`next_expected_at` integer,
	`status` text NOT NULL,
	`detail` text,
	`processed` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);