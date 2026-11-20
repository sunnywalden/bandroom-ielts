-- MT-5 (design rev3.1 G4 / license gate): per-tenant model feature entitlements.
-- The NC-licensed detector (Stage B self-listen) and commercial TTS must NOT run
-- for a tenant unless explicitly entitled. Default deny: a missing row means the
-- feature is OFF for that tenant. The owner is entitled by deployment config.
CREATE TABLE IF NOT EXISTS `user_entitlements` (
	`user_id` text NOT NULL,
	`feature` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	PRIMARY KEY(`user_id`, `feature`)
);