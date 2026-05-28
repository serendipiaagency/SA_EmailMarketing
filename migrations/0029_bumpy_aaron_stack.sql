CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`template_slug` text NOT NULL,
	`from_address` text NOT NULL,
	`tag` text,
	`sequence_id` text NOT NULL,
	`total_recipients` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_created_at_idx` ON `campaigns` (`created_at`);