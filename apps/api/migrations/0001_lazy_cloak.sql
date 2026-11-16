PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'd1' NOT NULL,
	`name` text NOT NULL,
	`cf_account_id` text,
	`d1_database_id` text,
	`base_url` text,
	`token_ciphertext` text NOT NULL,
	`token_iv` text NOT NULL,
	`token_hint` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "type", "name", "cf_account_id", "d1_database_id", "base_url", "token_ciphertext", "token_iv", "token_hint", "is_demo", "created_at", "updated_at") SELECT "id", 'd1', "name", "cf_account_id", "d1_database_id", NULL, "token_ciphertext", "token_iv", "token_hint", "is_demo", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;