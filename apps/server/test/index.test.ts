import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { setTimeout as realSleep } from "node:timers/promises";
import Database from "better-sqlite3";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queries } from "../src/github/index.js";
import { createFakeSyncGithub } from "./sync-fake.js";
import { githubEnv, SENTINEL, validEnv, freePort } from "./helpers.js";
import { createSession, SESSION_TTL_MS } from "../src/auth/sessions/index.js";
import { openAndMigrate, schema } from "../src/db/index.js";
import { addUser, signIn } from "./sign-in.js";
import { accessHandlers, storeTokens } from "./access.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  createFakeGithub,
  FAKE_API_URL,
  graphqlRequests,
  INSTALLATION_ID,
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
    stubEnv({ ...validEnv, ...githubEnv });
    const entry = await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/nope`, {
      headers: { Cookie: signIn(entry.database.db).cookie },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });

  it("schedules the daily session cleanup", async () => {
    stubEnv({ ...validEnv, ...githubEnv });
    const entry = await start();
    const user = signIn(entry.database.db);
    entry.database.sqlite
      .prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = ?")
      .run(user.userId);
    expect(entry.jobs.enqueue("sessions.cleanup", undefined)).toBe(true);
    const deadline = Date.now() + 5000;
    const count = () =>
      entry.database.sqlite.prepare("SELECT count(*) FROM sessions").pluck();
    while (count().get() !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(count().get()).toBe(0);
  });

  it("cleans up expired sessions and orphaned tokens shortly after start", async () => {
    const seed = openAndMigrate(dataDir);
    const lapsed = addUser(seed.db);
    createSession(seed.db, lapsed.id, Date.now() - SESSION_TTL_MS - 1);
    const active = signIn(seed.db);
    for (const userId of [lapsed.id, active.userId]) {
      seed.db
        .insert(schema.userTokens)
        .values({
          userId,
          accessTokenEnc: "v1:a:b:c",
          accessExpiresAt: 1,
          refreshTokenEnc: "v1:a:b:c",
          refreshExpiresAt: 1,
          updatedAt: 1,
        })
        .run();
    }
    seed.sqlite.close();

    stubEnv({ ...validEnv, ...githubEnv });
    const entry = await start();
    const count = (table: string) =>
      entry.database.sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck();
    const deadline = Date.now() + 3000;
    while (
      (count("sessions").get() !== 1 || count("user_tokens").get() !== 1) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(count("sessions").get()).toBe(1);
    expect(
      entry.database.sqlite
        .prepare("SELECT user_id FROM user_tokens")
        .pluck()
        .all(),
    ).toEqual([active.userId]);
  });

  it("schedules the hourly access computation for users with a live session", async () => {
    const seed = openAndMigrate(dataDir);
    const live = signIn(seed.db, addUser(seed.db, "alice").id);
    const lapsed = addUser(seed.db, "bob");
    createSession(seed.db, lapsed.id, Date.now() - SESSION_TTL_MS - 1);
    storeTokens(seed.db, validEnv.CROSSBOARD_APP_SECRET, live.userId, {
      access: "ghu_alice",
    });
    storeTokens(seed.db, validEnv.CROSSBOARD_APP_SECRET, lapsed.id, {
      access: "ghu_bob",
    });
    seed.sqlite.close();

    stubEnv({
      ...validEnv,
      CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
      CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    });
    const fake = createFakeGithub();
    fake.listen();
    fake.server.use(
      ...accessHandlers({
        ghu_alice: {
          installations: [{ id: 1, login: "alice" }],
          repos: {
            1: [{ id: 10, nodeId: "R_10", owner: "alice", name: "notes" }],
          },
        },
        ghu_bob: {
          installations: [{ id: 2, login: "bob" }],
          repos: {
            2: [{ id: 20, nodeId: "R_20", owner: "bob", name: "secret" }],
          },
        },
      }),
    );
    try {
      const entry = await start();
      expect(() => entry.jobs.schedule("access.compute", 1000)).toThrow(
        /already scheduled/,
      );
      expect(entry.jobs.enqueue("access.compute", undefined)).toBe(true);
      const access = () =>
        entry.database.sqlite
          .prepare(
            "SELECT user_id, repo_id FROM user_repo_access ORDER BY user_id",
          )
          .all();
      const deadline = Date.now() + 5000;
      while (access().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(access()).toEqual([{ user_id: live.userId, repo_id: "R_10" }]);
    } finally {
      fake.close();
    }
  });

  describe("repository discovery", () => {
    const discoveryEnv = () => ({
      ...validEnv,
      ...githubEnv,
      GITHUB_APP_ID: APP_ID,
      GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
      CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
      CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    });
    const github = createFakeSyncGithub();
    // The repository the installation lists, with the three open issues
    // discovery counts and the sync then stores.
    const repoWithIssues = () => {
      github.world.repos = [
        {
          name: "octocat/repo-1",
          id: "R_1",
          issues: [1, 2, 3].map((number) => ({
            id: `I_${String(number)}`,
            repo: "octocat/repo-1",
            number,
          })),
        },
      ];
      return [github.graphql];
    };
    const repos = (entry: Awaited<ReturnType<typeof start>>) =>
      entry.database.sqlite
        .prepare(
          "SELECT id, installation_id, sync_state, open_issue_count FROM repos",
        )
        .all();
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!done() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const installationRow = (id: number, login: string) => ({
      id,
      accountLogin: login,
      accountId: id,
      accountType: "User" as const,
      suspended: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const readyWithIssues = (entry: Awaited<ReturnType<typeof start>>) =>
      repos(entry).length > 0 &&
      (repos(entry)[0] as { sync_state: string }).sync_state === "ready";
    const issueIds = (entry: Awaited<ReturnType<typeof start>>) =>
      entry.database.sqlite
        .prepare("SELECT id FROM issues ORDER BY number")
        .all();

    it("discovers the repositories of every active installation at startup and syncs them", async () => {
      const seed = openAndMigrate(dataDir);
      seed.db
        .insert(schema.installations)
        .values([
          installationRow(INSTALLATION_ID, "octocat"),
          installationRow(8, "stranger"),
        ])
        .run();
      seed.sqlite.close();
      stubEnv(discoveryEnv());
      const fake = createFakeGithub();
      fake.listen();
      fake.server.use(...repoWithIssues());
      try {
        const entry = await start();
        await until(() => readyWithIssues(entry));
        expect(repos(entry)).toEqual([
          {
            id: "R_1",
            installation_id: INSTALLATION_ID,
            sync_state: "ready",
            open_issue_count: 3,
          },
        ]);
        expect(issueIds(entry)).toEqual([
          { id: "I_1" },
          { id: "I_2" },
          { id: "I_3" },
        ]);
      } finally {
        fake.close();
      }
    });

    it("resumes a repository a restart interrupted while it was syncing", async () => {
      const seed = openAndMigrate(dataDir);
      seed.db
        .insert(schema.installations)
        .values(installationRow(INSTALLATION_ID, "octocat"))
        .run();
      seed.db
        .insert(schema.repos)
        .values({
          id: "R_1",
          databaseId: 1,
          installationId: INSTALLATION_ID,
          owner: "octocat",
          name: "repo-1",
          private: false,
          syncState: "syncing",
          openIssueCount: 3,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      seed.sqlite.close();
      stubEnv(discoveryEnv());
      const fake = createFakeGithub();
      fake.listen();
      fake.server.use(...repoWithIssues());
      try {
        const entry = await start();
        await until(() => readyWithIssues(entry));
        expect(repos(entry)).toEqual([
          {
            id: "R_1",
            installation_id: INSTALLATION_ID,
            sync_state: "ready",
            open_issue_count: 3,
          },
        ]);
        expect(issueIds(entry)).toHaveLength(3);
      } finally {
        fake.close();
      }
    });

    it("discovers and syncs an installation when an access computation makes it active", async () => {
      const seed = openAndMigrate(dataDir);
      const live = signIn(seed.db, addUser(seed.db, "octocat").id);
      storeTokens(seed.db, validEnv.CROSSBOARD_APP_SECRET, live.userId, {
        access: "ghu_octocat",
      });
      seed.db
        .insert(schema.installations)
        .values(installationRow(INSTALLATION_ID, "octocat-org"))
        .run();
      seed.sqlite.close();
      stubEnv(discoveryEnv());
      const fake = createFakeGithub();
      fake.listen();
      fake.server.use(
        ...repoWithIssues(),
        ...accessHandlers({
          ghu_octocat: {
            installations: [{ id: INSTALLATION_ID, login: "octocat-org" }],
            repos: {
              [INSTALLATION_ID]: [
                { id: 1, nodeId: "R_1", owner: "octocat", name: "repo-1" },
              ],
            },
          },
        }),
      );
      try {
        const entry = await start();
        expect(repos(entry)).toEqual([]);
        expect(entry.jobs.enqueue("access.compute", undefined)).toBe(true);
        await until(() => readyWithIssues(entry));
        expect(repos(entry)).toEqual([
          {
            id: "R_1",
            installation_id: INSTALLATION_ID,
            sync_state: "ready",
            open_issue_count: 3,
          },
        ]);
        expect(issueIds(entry)).toHaveLength(3);
      } finally {
        fake.close();
      }
    });
  });

  it("gates a fresh instance behind the setup token it logs at start", async () => {
    stubEnv(validEnv);
    await start();

    const logged = output
      .join("")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            level: number;
            msg: string;
            setupToken?: string;
          },
      )
      .find((record) => record.setupToken !== undefined);
    expect(logged?.level).toBe(40);
    const token = logged?.setupToken ?? "";
    expect(token).not.toBe("");

    const base = `http://127.0.0.1:${port}`;
    const redirect = await fetch(`${base}/api/issues`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/setup");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);

    const headers = {
      Origin: validEnv.CROSSBOARD_PUBLIC_URL,
      "Content-Type": "application/json",
    };
    const wrong = await fetch(`${base}/api/setup/token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await fetch(`${base}/api/setup/token`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    });
    expect(right.status).toBe(204);
    expect(right.headers.get("set-cookie")).toContain("HttpOnly");
    expect(rowsOf("app_config")).toBe(1);
  });

  it("serves normally and logs no setup token when the environment has the App credentials", async () => {
    stubEnv({ ...validEnv, ...githubEnv });
    await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/issues`, {
      redirect: "manual",
    });
    expect(response.status).toBe(401);
    expect(output.join("")).not.toContain("setupToken");
    expect(rowsOf("app_config")).toBe(0);
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

  it("creates the installation client that queries GitHub with installation tokens", async () => {
    stubEnv({
      ...validEnv,
      ...githubEnv,
      GITHUB_APP_ID: APP_ID,
      GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
      CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
      CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    });
    const fake = createFakeGithub();
    fake.listen();
    try {
      const entry = await start();
      expect(
        await entry.installations.graphql(
          INSTALLATION_ID,
          queries.openIssuesPage,
          { owner: "octocat", name: "repo-1" },
          { repo: "octocat/repo-1" },
        ),
      ).toMatchObject({ rateLimit: { cost: 4 } });
      expect(fake.requests.map((request) => request.method)).toEqual([
        "POST",
        "POST",
      ]);
      expect(graphqlRequests).toHaveLength(1);
      expect(output.join("")).not.toContain("ghs_fake_installation_token");
    } finally {
      fake.close();
    }
  });

  it("tracks budgets and limits concurrency in the clients it creates", async () => {
    stubEnv({
      ...validEnv,
      ...githubEnv,
      GITHUB_APP_ID: APP_ID,
      GITHUB_PRIVATE_KEY: APP_PRIVATE_KEY,
      CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
      CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    });
    const fake = createFakeGithub();
    fake.listen();
    try {
      const entry = await start();
      expect(entry.installations.budgets.get(INSTALLATION_ID)).toEqual({
        rest: null,
        graphql: null,
      });
      await entry.installations.graphql(
        INSTALLATION_ID,
        queries.openIssuesPage,
        {
          owner: "octocat",
          name: "repo-1",
        },
      );
      expect(entry.github.budgets.get(INSTALLATION_ID).graphql).toMatchObject({
        remaining: 4996,
      });

      let inFlight = 0;
      let peak = 0;
      const release: (() => void)[] = [];
      fake.server.use(
        http.get(`${FAKE_API_URL}/installation/repositories`, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => release.push(resolve));
          inFlight--;
          return HttpResponse.json({ total_count: 0, repositories: [] });
        }),
      );
      const calls = Array.from({ length: 8 }, (_, index) =>
        entry.github.restGet(
          `token-${String(index)}`,
          "GET /installation/repositories",
        ),
      );
      await vi.waitFor(() => expect(inFlight).toBe(4));
      await realSleep(50);
      expect(inFlight).toBe(4);
      let settled = false;
      void Promise.all(calls).then(() => {
        settled = true;
      });
      const deadline = Date.now() + 4_000;
      while (!settled && Date.now() < deadline) {
        for (const done of release.splice(0)) done();
        await realSleep(5);
      }
      expect(settled).toBe(true);
      expect(peak).toBe(4);
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

  it("closes the database within one grace period of the signal when a connection and a job both hang", async () => {
    stubEnv(validEnv);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let exitCode: unknown = "pending";
    exit.mockImplementation((code?: string | number | null) => {
      exitCode = code;
      return undefined as never;
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
    // An incomplete request keeps the connection open, so server.close() only
    // finishes once the entry force-closes it.
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    await new Promise((resolve) => client.once("connect", resolve));
    client.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\n");
    await realSleep(50);

    // Only setTimeout is faked, so sockets and promises keep running for real.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      process.emit("SIGTERM", "SIGTERM");
      // A single grace period after the signal, not one per phase.
      await vi.advanceTimersByTimeAsync(5_000);
      for (let i = 0; i < 40 && exitCode === "pending"; i += 1) {
        await realSleep(25);
      }
      expect(exitCode).toBe(0);
      expect(entry.database.sqlite.open).toBe(false);
    } finally {
      vi.useRealTimers();
      client.destroy();
      release();
    }
    opened.pop();
  });
});
