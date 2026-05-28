CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`source` text NOT NULL,
	`basis` text NOT NULL,
	`note` text,
	`ip_prefix` text,
	`consented_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `consents_person_idx` ON `consents` (`person_id`,`consented_at`);