CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`idp_iss` text NOT NULL,
	`idp_sub` text NOT NULL,
	`email_normalized` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'learner' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`consent_version` text,
	`consent_at` integer,
	`revoked_at` integer,
	`revocation_epoch` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_idp_sub` ON `users` (`idp_iss`,`idp_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email` ON `users` (`email_normalized`);--> statement-breakpoint
CREATE INDEX `users_status` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `user_cost_ledger` (
	`user_id` text NOT NULL,
	`utc_day` text NOT NULL,
	`spent_micro_cny` integer DEFAULT 0 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `utc_day`)
);