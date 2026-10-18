CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value_enc` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `installations` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_login` text NOT NULL,
	`account_id` integer NOT NULL,
	`account_type` text NOT NULL,
	`suspended` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_installations` (
	`user_id` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `installation_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_tokens` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`access_token_enc` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` integer NOT NULL,
	`login` text NOT NULL,
	`name` text,
	`avatar_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`private` integer NOT NULL,
	`sync_state` text NOT NULL,
	`sync_detail` text,
	`open_issue_count` integer NOT NULL,
	`last_full_sync_at` integer,
	`last_reconciled_at` integer,
	`reconcile_since` text,
	`rest_etag` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_database_id_unique` ON `repos` (`database_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name_unique` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `user_repo_access` (
	`user_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `repo_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_assignees` (
	`issue_id` text NOT NULL,
	`login` text NOT NULL,
	`avatar_url` text NOT NULL,
	PRIMARY KEY(`issue_id`, `login`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_deps` (
	`blocked_id` text NOT NULL,
	`blocking_id` text NOT NULL,
	PRIMARY KEY(`blocked_id`, `blocking_id`)
);
--> statement-breakpoint
CREATE TABLE `issue_details` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`body_html` text NOT NULL,
	`comments_json` text NOT NULL,
	`comments_total` integer NOT NULL,
	`sub_issues_json` text NOT NULL,
	`fetched_for_updated_at` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_labels` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_full_name` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`url` text NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`database_id` integer NOT NULL,
	`repo_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`author_login` text,
	`type_name` text,
	`type_color` text,
	`milestone_title` text,
	`milestone_url` text,
	`parent_id` text,
	`sub_total` integer NOT NULL,
	`sub_completed` integer NOT NULL,
	`blocked_by_total` integer NOT NULL,
	`blocking_total` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_repo_id_number_unique` ON `issues` (`repo_id`,`number`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_repo_id_name_unique` ON `labels` (`repo_id`,`name`);--> statement-breakpoint
CREATE TABLE `board_columns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`filter` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_columns_board_id_position_unique` ON `board_columns` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`base_filter` text NOT NULL,
	`sort` text NOT NULL,
	`sub_issue_mode` text NOT NULL,
	`show_other` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`filter` text NOT NULL,
	`sort` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_user_id_name_unique` ON `saved_views` (`user_id`,`name`);