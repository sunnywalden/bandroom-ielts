CREATE TABLE `automation_heartbeats` (
	`user_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`client_run_id` text,
	`started_at` integer,
	`finished_at` integer,
	`last_success_at` integer,
	`next_expected_at` integer,
	`status` text NOT NULL,
	`detail` text,
	PRIMARY KEY(`user_id`, `automation_id`)
);
