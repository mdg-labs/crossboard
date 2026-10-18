import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { users } from "./users.js";

export const boards = sqliteTable("boards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  baseFilter: text("base_filter").notNull(),
  sort: text("sort").notNull(),
  subIssueMode: text("sub_issue_mode").notNull(),
  showOther: integer("show_other", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const boardColumns = sqliteTable(
  "board_columns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boardId: integer("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    filter: text("filter").notNull(),
  },
  (table) => [unique().on(table.boardId, table.position)],
);

export const savedViews = sqliteTable(
  "saved_views",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filter: text("filter").notNull(),
    sort: text("sort").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.userId, table.name)],
);
