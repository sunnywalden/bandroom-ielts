ALTER TABLE `review_receipts` ADD `output_sha256_v2` text;--> statement-breakpoint
ALTER TABLE `review_tasks` ADD `claim_kind` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `review_tasks` ADD `manual_grant_sha256` text;--> statement-breakpoint
ALTER TABLE `review_tasks` ADD `notification_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_tasks` ADD `retry_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_tasks` ADD `claimed_client_run_id` text;--> statement-breakpoint
ALTER TABLE `scheduler_heartbeats` ADD `owner_user_id` text;