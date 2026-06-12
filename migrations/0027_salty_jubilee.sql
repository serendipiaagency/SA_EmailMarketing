CREATE TABLE `email_events` (
	`id` text PRIMARY KEY NOT NULL,
	`sent_email_id` text NOT NULL,
	`recipient` text NOT NULL,
	`kind` text NOT NULL,
	`url` text,
	`user_agent` text,
	`ip_prefix` text,
	`event_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_events_sent_at_idx` ON `email_events` (`sent_email_id`,`event_at`);--> statement-breakpoint
CREATE INDEX `email_events_kind_at_idx` ON `email_events` (`kind`,`event_at`);--> statement-breakpoint
CREATE INDEX `email_events_recipient_at_idx` ON `email_events` (`recipient`,`event_at`);