ALTER TABLE `analysis_events` ADD COLUMN `user_id` text;--> statement-breakpoint
CREATE INDEX `analysis_events_user` ON `analysis_events` (`user_id`,`at`);--> statement-breakpoint
UPDATE `analysis_events` SET `user_id` = (
	SELECT `user_id` FROM `review_tasks` WHERE `review_tasks`.`id` = `analysis_events`.`task_id`
) WHERE `user_id` IS NULL AND `task_id` IS NOT NULL;