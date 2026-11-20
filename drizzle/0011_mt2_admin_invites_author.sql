-- MT-2 (design rev3.1 §4.2/§4.6): admin audit trail, invite/approval state
-- machine, and feedback author provenance. Additive; existing rows unchanged.

-- Append-only admin action log. Never stores learner content. break-glass
-- reads are logged synchronously before content is returned (S10.1).
CREATE TABLE IF NOT EXISTS `admin_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_user_id` text,
	`reason` text,
	`expires_at` integer,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `admin_audit_actor` ON `admin_audit` (`actor_user_id`,`at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `admin_audit_target` ON `admin_audit` (`target_user_id`,`at`);
--> statement-breakpoint

-- Invite codes for the approval gate (Z-1). code is stored hashed; a pending
-- tenant becomes active only via admin approve or a valid invite redemption.
CREATE TABLE IF NOT EXISTS `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'learner' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`used_at` integer,
	`used_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invites_code_hash` ON `invites` (`code_hash`);
--> statement-breakpoint

-- S3.1: feedback author provenance. Distinguishes learner self-notes from
-- coach/runner feedback so a learner cannot forge coach/detector output.
-- Existing rows are coach-authored (the only writer before MT-2).
ALTER TABLE `teacher_feedback` ADD COLUMN `author_scope` text DEFAULT 'coach' NOT NULL;
--> statement-breakpoint

-- Personal access tokens for learner MCP connectors (MVP; OAuth later).
-- Stored hashed; revocable; bound to one tenant.
CREATE TABLE IF NOT EXISTS `user_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_tokens_hash` ON `user_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_tokens_user` ON `user_tokens` (`user_id`);