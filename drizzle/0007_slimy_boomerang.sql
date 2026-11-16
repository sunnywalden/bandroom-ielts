CREATE TABLE `calibration_candidates` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`word` text NOT NULL,
	`expected` text NOT NULL,
	`actual` text NOT NULL,
	`at_ms` integer NOT NULL,
	`detector_confidence` real NOT NULL,
	`shown_at` integer NOT NULL,
	`answered_at` integer
);
--> statement-breakpoint
CREATE INDEX `calibration_candidates_user_attempt` ON `calibration_candidates` (`user_id`,`attempt_id`);--> statement-breakpoint
CREATE TABLE `calibration_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`expected` text NOT NULL,
	`actual` text NOT NULL,
	`verdict` text NOT NULL,
	`is_catch_trial` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calibration_events_candidate` ON `calibration_events` (`user_id`,`attempt_id`,`candidate_id`);--> statement-breakpoint
CREATE INDEX `calibration_events_profile` ON `calibration_events` (`user_id`,`expected`,`actual`);--> statement-breakpoint
CREATE TABLE `personal_calibration` (
	`user_id` text NOT NULL,
	`expected` text NOT NULL,
	`actual` text NOT NULL,
	`n_confirmed` integer DEFAULT 0 NOT NULL,
	`n_rejected` integer DEFAULT 0 NOT NULL,
	`n_unsure` integer DEFAULT 0 NOT NULL,
	`n_shown` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'CANDIDATE' NOT NULL,
	`rule_version` text NOT NULL,
	`detector_version` text NOT NULL,
	`inventory_version` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `expected`, `actual`)
);
--> statement-breakpoint
CREATE INDEX `personal_calibration_user_state` ON `personal_calibration` (`user_id`,`state`);