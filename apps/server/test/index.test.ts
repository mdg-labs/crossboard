import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubEnv, SENTINEL, validEnv, freePort } from "./helpers.js";

let output: string[];
let exit: ReturnType<typeof vi.spyOn>;
let dataDir: string;
let opened: { sqlite: Database.Database; server: Server }[];
let port: number;

beforeEach(async () => {
  port = await freePort();
  output = [];
  opened = [];
  dataDir = mkdtempSync(join(tmpdir(), "crossboard-entry-"));
  vi.resetModules();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  for (const handle of opened) {
    handle.server.close();
    handle.server.closeAllConnections();
    handle.sqlite.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubEnv(env: Record<string, string>) {
  for (const name of [
    ...Object.keys(validEnv),
    ...Object.keys(githubEnv),
    "LOG_LEVEL",
    "PORT",
    "CROSSBOARD_DATA_DIR",
  ]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("CROSSBOARD_DATA_DIR", dataDir);
  vi.stubEnv("PORT", String(port));
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}

async function start() {
  const entry = await import("../src/index.js");
  opened.push({ sqlite: entry.database.sqlite, server: entry.server });
  return entry;
}

function rowsOf(table: string) {
  const sqlite = new Database(join(dataDir, "crossboard.db"), {
    readonly: true,
  });
  try {
    return sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  } finally {
    sqlite.close();
  }
}

describe("process entry", () => {
  it("loads the config from the environment and creates the logger", async () => {
    stubEnv({ ...validEnv, LOG_LEVEL: "warn" });
    const entry = await start();
    expect(entry.config.port).toBe(port);
    expect(entry.logger.level).toBe("warn");
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs a JSON fatal naming the variables and exits when the config is invalid", async () => {
    stubEnv({
      ...validEnv,
      CROSSBOARD_APP_SECRET: SENTINEL.slice(0, 12),
      PORT: SENTINEL,
    });
    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    const record = JSON.parse(output.join(""));
    expect(record.level).toBe(60);
    expect(record.msg).toContain("CROSSBOARD_APP_SECRET");
    expect(record.msg).toContain("PORT");
    expect(output.join("")).not.toContain(SENTINEL.slice(0, 12));
  });

  it("exits when a GitHub App credential set is partial", async () => {
    stubEnv({ ...validEnv, GITHUB_APP_ID: "123" });
    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    expect(output.join("")).toContain("GITHUB_PRIVATE_KEY");
  });

  it("opens <data dir>/crossboard.db and applies the migrations after loading the config", async () => {
    stubEnv(validEnv);
    const entry = await start();
    expect(entry.database.path).toBe(join(dataDir, "crossboard.db"));
    expect(entry.database.sqlite.pragma("journal_mode", { simple: true })).toBe(
      "wal",
    );
    expect(entry.database.sqlite.pragma("foreign_keys", { simple: true })).toBe(
      1,
    );
    expect(rowsOf("__drizzle_migrations")).toBe(1);
    expect(rowsOf("boards")).toBe(0);
  });

  it("applies nothing twice and keeps the data across a restart", async () => {
    stubEnv(validEnv);
    const first = await start();
    first.database.sqlite.exec(
      "INSERT INTO users VALUES (1, 1, 'a', NULL, 'u', 0, 0)",
    );
    await new Promise<void>((resolve) => {
      first.server.close(() => resolve());
      first.server.closeAllConnections();
    });
    first.database.sqlite.close();
    opened.pop();

    vi.resetModules();
    await start();
    expect(rowsOf("__drizzle_migrations")).toBe(1);
    expect(rowsOf("users")).toBe(1);
  });

  it("logs a JSON fatal and exits non-zero when a migration fails", async () => {
    stubEnv(validEnv);
    const existing = new Database(join(dataDir, "crossboard.db"));
    existing.exec("CREATE TABLE users (id integer)");
    existing.close();

    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    const record = JSON.parse(output.join("").trim().split("\n").at(-1) ?? "");
    expect(record.level).toBe(60);
    expect(record.msg).toContain("migrations");
    expect(rowsOf("__drizzle_migrations")).toBe(0);
  });

  it("exits non-zero when the data directory cannot be used", async () => {
    stubEnv(validEnv);
    vi.stubEnv("CROSSBOARD_DATA_DIR", join(dataDir, "crossboard.db", "nested"));
    new Database(join(dataDir, "crossboard.db")).close();
    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    expect(JSON.parse(output.join("").trim()).level).toBe(60);
  });

  it("serves /api/health on PORT once the migrations are applied", async () => {
    stubEnv(validEnv);
    await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(await response.json()).toEqual({
      status: "ok",
      version: manifest.version,
    });
    expect(output.join("")).toContain('"msg":"listening"');
  });

  it("answers unknown /api routes in the error shape through the listener", async () => {
    stubEnv(validEnv);
    await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });

  it("logs a JSON fatal and exits non-zero when the port is taken", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, resolve));
    try {
      stubEnv(validEnv);
      const exited = new Promise<unknown>((resolve) => {
        exit.mockImplementation((code?: string | number | null) => {
          resolve(code);
          return undefined as never;
        });
      });
      const entry = await import("../src/index.js");
      expect(await exited).toBe(1);
      const fatal = output
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { level: number; msg: string })
        .find((record) => record.level === 60);
      expect(fatal?.msg).toContain("HTTP server");
      entry.database.sqlite.close();
    } finally {
      holder.close();
    }
  });
});
