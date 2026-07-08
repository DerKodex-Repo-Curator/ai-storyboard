CREATE TABLE `sub_agent_learnings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`image_id` text,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_sub_agent_learnings_project` ON `sub_agent_learnings` (`project_id`);