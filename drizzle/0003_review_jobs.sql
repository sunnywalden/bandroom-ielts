CREATE TABLE `review_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`day` integer NOT NULL,
	`submission_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_jobs_submission` ON `review_jobs` (`user_id`,`submission_key`);--> statement-breakpoint
CREATE INDEX `review_jobs_user_day` ON `review_jobs` (`user_id`,`day`);