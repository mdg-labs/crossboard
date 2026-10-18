import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema/index.js";

export { schema };

export const DATABASE_FILE = "crossboard.db";

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: Db;
  sqlite: Database.Database;
  path: string;
}

export function openDatabase(dataDir: string): DatabaseHandle {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, DATABASE_FILE);
  const sqlite = new Database(path);
  try {
    const journalMode = sqlite.pragma("journal_mode = WAL", { simple: true });
    if (journalMode !== "wal") {
      throw new Error(
        `${path} could not be switched to WAL mode (journal_mode is ${String(journalMode)})`,
      );
    }
    sqlite.pragma("foreign_keys = ON");
    if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error(
        `foreign key enforcement could not be enabled on ${path}`,
      );
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { db: drizzle(sqlite, { schema }), sqlite, path };
}

export function migrateDatabase(
  db: Db,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): void {
  migrate(db, { migrationsFolder });
}

export function openAndMigrate(dataDir: string): DatabaseHandle {
  const handle = openDatabase(dataDir);
  try {
    migrateDatabase(handle.db);
  } catch (error) {
    handle.sqlite.close();
    throw error;
  }
  return handle;
}
