-- MT-4 (design rev3.1 §4.5, B6/S12): per-tenant daily usage counters for quotas.
-- One row per (user, utc_day); incremented atomically on submit/upload/model call.
CREATE TABLE IF NOT EXISTS `user_usage_daily` (
	`user_id` text NOT NULL,
	`utc_day` text NOT NULL,
	`submissions` integer DEFAULT 0 NOT NULL,
	`audio_bytes` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `utc_day`)
);
--> statement-breakpoint
-- Per-IP/domain registration + login-failure throttle (anonymous abuse surface).
CREATE TABLE IF NOT EXISTS `rate_limit_buckets` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`updated_at` integer NOT NULL
);