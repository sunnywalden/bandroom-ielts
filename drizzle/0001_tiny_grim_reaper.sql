CREATE TABLE `teacher_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`day` integer NOT NULL,
	`stage` text NOT NULL,
	`attempt` text NOT NULL,
	`evidence` text NOT NULL,
	`feedback` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `teacher_feedback_user_day` ON `teacher_feedback` (`user_id`,`day`);--> statement-breakpoint
CREATE TABLE `teacher_lessons` (
	`user_id` text NOT NULL,
	`day` integer NOT NULL,
	`lesson` text NOT NULL,
	PRIMARY KEY(`user_id`, `day`)
);
