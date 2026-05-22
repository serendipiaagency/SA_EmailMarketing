CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`source` text,
	`sent_email_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_email_unique` ON `suppressions` (`email`);--> statement-breakpoint
CREATE INDEX `suppressions_reason_idx` ON `suppressions` (`reason`);--> statement-breakpoint
CREATE INDEX `suppressions_created_at_idx` ON `suppressions` (`created_at`);