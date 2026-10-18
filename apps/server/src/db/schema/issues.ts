import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { repos } from "./repos.js";

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    databaseId: integer("database_id").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    authorLogin: text("author_login"),
    typeName: text("type_name"),
    typeColor: text("type_color"),
    milestoneTitle: text("milestone_title"),
    milestoneUrl: text("milestone_url"),
    parentId: text("parent_id"),
    subTotal: integer("sub_total").notNull(),
    subCompleted: integer("sub_completed").notNull(),
    blockedByTotal: integer("blocked_by_total").notNull(),
    blockingTotal: integer("blocking_total").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    syncedAt: integer("synced_at").notNull(),
  },
  (table) => [unique().on(table.repoId, table.number)],
);

export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description"),
  },
  (table) => [unique().on(table.repoId, table.name)],
);

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.labelId] })],
);

export const issueAssignees = sqliteTable(
  "issue_assignees",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    login: text("login").notNull(),
    avatarUrl: text("avatar_url").notNull(),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.login] })],
);

export const issueRefs = sqliteTable("issue_refs", {
  id: text("id").primaryKey(),
  repoFullName: text("repo_full_name").notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  state: text("state", { enum: ["OPEN", "CLOSED"] }).notNull(),
  url: text("url").notNull(),
  seenAt: integer("seen_at").notNull(),
});

export const issueDeps = sqliteTable(
  "issue_deps",
  {
    blockedId: text("blocked_id").notNull(),
    blockingId: text("blocking_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.blockedId, table.blockingId] })],
);

export const issueDetails = sqliteTable("issue_details", {
  issueId: text("issue_id")
    .primaryKey()
    .references(() => issues.id, { onDelete: "cascade" }),
  bodyHtml: text("body_html").notNull(),
  commentsJson: text("comments_json").notNull(),
  commentsTotal: integer("comments_total").notNull(),
  subIssuesJson: text("sub_issues_json").notNull(),
  fetchedForUpdatedAt: integer("fetched_for_updated_at").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});
