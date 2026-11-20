-- MT-2 (S9.3): allow the revoked-tenant tombstone to clear direct PII.
-- users.email_normalized was NOT NULL in 0008; revocation must blank it while
-- keeping user_id + idp (iss, sub) as the permanent tombstone key. SQLite can
-- only drop a NOT NULL constraint by rebuilding the table, so preserve every
-- column and recreate the indexes (no foreign keys reference users).
CREATE TABLE `users_new` (
	`user_id` text PRIMARY KEY NOT NULL,
	`idp_iss` text NOT NULL,
	`idp_sub` text NOT NULL,
	`email_normalized` text,
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
INSERT INTO `users_new`
	(`user_id`,`idp_iss`,`idp_sub`,`email_normalized`,`display_name`,`role`,`status`,
	 `consent_version`,`consent_at`,`revoked_at`,`revocation_epoch`,`created_at`,`updated_at`)
	SELECT `user_id`,`idp_iss`,`idp_sub`,`email_normalized`,`display_name`,`role`,`status`,
	 `consent_version`,`consent_at`,`revoked_at`,`revocation_epoch`,`created_at`,`updated_at`
	FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `users_new` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_idp_sub` ON `users` (`idp_iss`,`idp_sub`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email` ON `users` (`email_normalized`);
--> statement-breakpoint
CREATE INDEX `users_status` ON `users` (`status`);