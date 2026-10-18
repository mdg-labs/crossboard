import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubEnv, SENTINEL, validEnv, freePort } from "./helpers.js";
import {
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
  USER_TOKEN,
} from "./github-fake.js";

let output: string[];
let exit: ReturnType<typeof vi.spyOn>;
let dataDir: string;
let opened: {
  sqlite: Database.Database;
  server: Server;
  jobs: { stop(): Promise<void> };
}[];
let port: number;
let signalListeners: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

beforeEach(async () => {
  signalListeners = new Map(
    SIGNALS.map((signal) => [signal, process.listeners(signal)]),
  );
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

afterEach(async () => {
  for (const handle of opened) {
    await handle.jobs.stop();
    handle.server.close();
    handle.server.closeAllConnections();
    handle.sqlite.close();
  }
  // Every import of the entry registers its own signal handlers.
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners.get(signal)?.includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
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
  opened.push({
    sqlite: entry.database.sqlite,
    server: entry.server,
    jobs: entry.jobs,
  });
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

  it("creates the GitHub client from the configured base URLs", async () => {
    stubEnv({
      ...validEnv,
      CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
      CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    });
    const fake = createFakeGithub();
    fake.listen();
    try {
      const entry = await start();
      expect(await entry.github.getUser(USER_TOKEN)).toMatchObject({
        login: "octocat",
      });
      expect(fake.requests).toEqual([
        { method: "GET", url: `${FAKE_API_URL}/user` },
      ]);
    } finally {
      fake.close();
    }
  });

  it("starts the job scheduler once the migrations are applied", async () => {
    stubEnv(validEnv);
    const entry = await start();
    expect(entry.jobs.started).toBe(true);
    const ticks: number[] = [];
    entry.jobs.register(
      "probe",
      () => void ticks.push(rowsOf("users") as number),
    );
    entry.jobs.schedule("probe", 10);
    const deadline = Date.now() + 2_000;
    while (ticks.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ticks).toEqual([0]);
  });

  it.each(SIGNALS)(
    "closes the listener and the database and exits 0 on %s",
    async (signal) => {
      stubEnv(validEnv);
      const exited = new Promise<unknown>((resolve) => {
        exit.mockImplementation((code?: string | number | null) => {
          resolve(code);
          return undefined as never;
        });
      });
      const entry = await start();
      if (!entry.server.listening) {
        await new Promise((resolve) => entry.server.once("listening", resolve));
      }

      process.emit(signal, signal);
      expect(await exited).toBe(0);
      expect(entry.server.listening).toBe(false);
      expect(entry.database.sqlite.open).toBe(false);
      expect(entry.jobs.started).toBe(false);
      expect(output.join("")).toContain('"msg":"shutting down"');
      expect(process.listenerCount(signal)).toBe(
        signalListeners.get(signal)?.length,
      );
      opened.pop();
    },
  );

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

describe("process entry shutdown", () => {
  it("waits for a running job before it closes the database", async () => {
    stubEnv(validEnv);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exited = new Promise<unknown>((resolve) => {
      exit.mockImplementation((code?: string | number | null) => {
        resolve(code);
        return undefined as never;
      });
    });
    const entry = await start();
    if (!entry.server.listening) {
      await new Promise((resolve) => entry.server.once("listening", resolve));
    }
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    entry.jobs.register("slow", async () => {
      started();
      await held;
    });
    entry.jobs.enqueue("slow", null);
    await running;

    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entry.database.sqlite.open).toBe(true);
    release();
    expect(await exited).toBe(0);
    expect(entry.database.sqlite.open).toBe(false);
    opened.pop();
  });
});
