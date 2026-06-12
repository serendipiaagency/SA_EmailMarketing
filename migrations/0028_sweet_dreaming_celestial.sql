CREATE TABLE `people_tags` (
	`person_id` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `tag`)
);
--> statement-breakpoint
CREATE INDEX `people_tags_tag_idx` ON `people_tags` (`tag`);