import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Registry D1 schema. This database is AuthFleet's own store:
 * registered projects (with AES-GCM encrypted tokens) and daily
 * user-count snapshots. It never contains target projects' user data.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cfAccountId: text("cf_account_id").notNull(),
  d1DatabaseId: text("d1_database_id").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenIv: text("token_iv").notNull(),
  tokenHint: text("token_hint").notNull(),
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD (UTC) */
    date: text("date").notNull(),
    totalUsers: integer("total_users").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("snapshots_project_date").on(table.projectId, table.date)],
);
