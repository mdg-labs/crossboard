import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  MIGRATIONS_FOLDER,
  migrateDatabase,
  openDatabase,
} from "../src/db/index.js";

export type Row = Record<string, string | number | null>;

export interface MigrationCase {
  name: string;
  fromTag: string;
  rows: Record<string, Row[]>;
  preservedTables: Record<string, { orderBy: string }>;
}

interface Journal {
  entries: { tag: string }[];
}

export function readJournal(migrationsFolder: string = MIGRATIONS_FOLDER) {
  return JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}

function copyUpTo(migrationsFolder: string, tag: string, target: string) {
  const journal = readJournal(migrationsFolder);
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  if (last === -1) {
    throw new Error(`migration ${tag} is not in the journal`);
  }
  mkdirSync(join(target, "meta"), { recursive: true });
  const kept = journal.entries.slice(0, last + 1);
  writeFileSync(
    join(target, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  for (const entry of kept) {
    cpSync(
      join(migrationsFolder, `${entry.tag}.sql`),
      join(target, `${entry.tag}.sql`),
    );
  }
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

// Seeds rows at migration `fromTag`, migrates to the latest and asserts that
// nothing a user created was lost.
export function runMigrationCase(
  testCase: MigrationCase,
  migrationsFolder: string = MIGRATIONS_FOLDER,
) {
  const dir = mkdtempSync(join(tmpdir(), "crossboard-migration-"));
  const partial = join(dir, "partial");
  copyUpTo(migrationsFolder, testCase.fromTag, partial);
  const handle = openDatabase(join(dir, "data"));
  try {
    migrateDatabase(handle.db, partial);

    const tables = handle.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'",
      )
      .pluck()
      .all() as string[];
    expect(Object.keys(testCase.rows).sort()).toEqual([...tables].sort());

    for (const [table, rows] of Object.entries(testCase.rows)) {
      expect(rows.length, `${table} needs a seeded row`).toBeGreaterThan(0);
      for (const row of rows) {
        const columns = Object.keys(row);
        handle.sqlite
          .prepare(
            `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          )
          .run(...Object.values(row));
      }
    }

    migrateDatabase(handle.db, migrationsFolder);

    for (const [table, rows] of Object.entries(testCase.rows)) {
      const count = handle.sqlite
        .prepare(`SELECT count(*) FROM ${quote(table)}`)
        .pluck()
        .get();
      expect(count, `rows of ${table} after migrating`).toBeGreaterThanOrEqual(
        rows.length,
      );
    }
    for (const [table, { orderBy }] of Object.entries(
      testCase.preservedTables,
    )) {
      const columns = Object.keys(testCase.rows[table]?.[0] ?? {});
      const after = handle.sqlite
        .prepare(
          `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)} ORDER BY ${quote(orderBy)}`,
        )
        .all();
      expect(after, `${table} after migrating`).toEqual(
        [...(testCase.rows[table] ?? [])].sort(
          (a, b) => Number(a[orderBy]) - Number(b[orderBy]),
        ),
      );
    }

    expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
  } finally {
    handle.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
