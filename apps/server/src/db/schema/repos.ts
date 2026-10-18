import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { installations, users } from "./users.js";

export const SYNC_STATES = [
  "pending",
  "syncing",
  "ready",
  "error",
  "skipped",
] as const;

export const repos = sqliteTable(
  "repos",
  {
    id: text("id").primaryKey(),
    databaseId: integer("database_id").notNull().unique(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    private: integer("private", { mode: "boolean" }).notNull(),
    syncState: text("sync_state", { enum: SYNC_STATES }).notNull(),
    syncDetail: text("sync_detail"),
    openIssueCount: integer("open_issue_count").notNull(),
    lastFullSyncAt: integer("last_full_sync_at"),
    lastReconciledAt: integer("last_reconciled_at"),
    reconcileSince: text("reconcile_since"),
    restEtag: text("rest_etag"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.owner, table.name)],
);

export const userRepoAccess = sqliteTable(
  "user_repo_access",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    computedAt: integer("computed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.repoId] })],
);
