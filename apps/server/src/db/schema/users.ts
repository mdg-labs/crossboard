import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  valueEnc: text("value_enc").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubId: integer("github_id").notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url").notNull(),
  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at").notNull(),
});

export const userTokens = sqliteTable("user_tokens", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  accessExpiresAt: integer("access_expires_at").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  refreshExpiresAt: integer("refresh_expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const installations = sqliteTable("installations", {
  id: integer("id").primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountId: integer("account_id").notNull(),
  accountType: text("account_type", {
    enum: ["User", "Organization"],
  }).notNull(),
  suspended: integer("suspended", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const userInstallations = sqliteTable(
  "user_installations",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    computedAt: integer("computed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.installationId] })],
);
