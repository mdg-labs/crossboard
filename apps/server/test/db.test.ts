import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_FILE,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
  schema,
} from "../src/db/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { readJournal } from "./migration-harness.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDatabase();
});

afterEach(() => {
  testDb.cleanup();
});

const schemaTables = (): SQLiteTable[] =>
  Object.values(schema).flatMap((value) =>
    is(value, SQLiteTable) ? [value as SQLiteTable] : [],
  );

describe("database", () => {
  it("lives at <data dir>/crossboard.db in WAL mode with foreign keys on", () => {
    expect(testDb.path).toBe(join(testDb.dir, DATABASE_FILE));
    expect(existsSync(testDb.path)).toBe(true);
    expect(testDb.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(testDb.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("creates every table of the schema and no others", () => {
    const names = testDb.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'",
      )
      .pluck()
      .all();
    const expected = schemaTables().map((table) => getTableConfig(table).name);
    expect(expected).toHaveLength(18);
    expect([...names].sort()).toEqual([...expected].sort());
  });

  it("matches the schema column for column", () => {
    for (const table of schemaTables()) {
      const config = getTableConfig(table);
      const columns = testDb.sqlite
        .prepare(`PRAGMA table_info("${config.name}")`)
        .all() as { name: string; notnull: number; pk: number }[];
      expect(columns.map((column) => column.name).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
      for (const column of config.columns) {
        const actual = columns.find((entry) => entry.name === column.name);
        expect(actual?.notnull === 1 || column.primary).toBe(
          column.notNull || column.primary,
        );
      }
    }
  });

  it.each([
    ["users", ["github_id"]],
    ["repos", ["database_id"]],
    ["repos", ["owner", "name"]],
    ["issues", ["repo_id", "number"]],
    ["labels", ["repo_id", "name"]],
    ["board_columns", ["board_id", "position"]],
    ["saved_views", ["user_id", "name"]],
  ])("enforces the unique constraint on %s(%j)", (table, columns) => {
    const indexes = testDb.sqlite
      .prepare(`PRAGMA index_list("${table}")`)
      .all() as { name: string; unique: number }[];
    const unique = indexes
      .filter((index) => index.unique === 1)
      .map((index) =>
        testDb.sqlite
          .prepare(`PRAGMA index_info("${index.name}")`)
          .all()
          .map((column) => (column as { name: string }).name),
      );
    expect(unique).toContainEqual(columns);
  });

  it("cascades deletes through foreign keys, except issue_deps", () => {
    const { sqlite } = testDb;
    sqlite.exec(`
      INSERT INTO users VALUES (1, 1, 'a', NULL, 'u', 0, 0);
      INSERT INTO boards VALUES (1, 1, 'b', 'f', 's', 'm', 0, 0, 0);
      INSERT INTO board_columns VALUES (1, 1, 0, 'c', 'f');
      INSERT INTO saved_views VALUES (1, 1, 'v', 'f', 's', 0, 0);
      INSERT INTO issue_deps VALUES ('x', 'y');
    `);
    sqlite.exec("DELETE FROM users");
    for (const table of ["boards", "board_columns", "saved_views"]) {
      expect(
        sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
      ).toBe(0);
    }
    expect(
      sqlite.prepare("SELECT count(*) FROM issue_deps").pluck().get(),
    ).toBe(1);
    expect(sqlite.pragma("foreign_key_list(issue_deps)")).toEqual([]);
  });

  it("rejects a row that points at a missing parent", () => {
    expect(() =>
      testDb.sqlite.exec(
        "INSERT INTO boards VALUES (1, 99, 'b', 'f', 's', 'm', 0, 0, 0)",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("applies nothing twice when reopened", () => {
    testDb.sqlite.exec("INSERT INTO users VALUES (1, 1, 'a', NULL, 'u', 0, 0)");
    const applied = () =>
      testDb.sqlite
        .prepare("SELECT count(*) FROM __drizzle_migrations")
        .pluck()
        .get();
    expect(applied()).toBe(readJournal().entries.length);

    const reopened = openDatabase(testDb.dir);
    try {
      migrateDatabase(reopened.db);
      expect(applied()).toBe(readJournal().entries.length);
      expect(
        reopened.sqlite.prepare("SELECT count(*) FROM users").pluck().get(),
      ).toBe(1);
    } finally {
      reopened.sqlite.close();
    }
  });

  it("rolls a failing migration back and reports the failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "crossboard-failing-"));
    try {
      mkdirSync(join(dir, "meta"), { recursive: true });
      const [first] = readJournal().entries;
      cpSync(
        join(MIGRATIONS_FOLDER, `${first?.tag}.sql`),
        join(dir, `${first?.tag}.sql`),
      );
      writeFileSync(
        join(dir, "0001_broken.sql"),
        "CREATE TABLE `partial` (`id` integer);\n--> statement-breakpoint\nCREATE TABLE `users` (`id` integer);",
      );
      writeFileSync(
        join(dir, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "sqlite",
          entries: [
            first,
            {
              idx: 1,
              version: "6",
              when: 9_999_999_999_999,
              tag: "0001_broken",
              breakpoints: true,
            },
          ],
        }),
      );
      expect(() => migrateDatabase(testDb.db, dir)).toThrow(
        /Failed to run the query/,
      );
      const partial = testDb.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = 'partial'")
        .get();
      expect(partial).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
