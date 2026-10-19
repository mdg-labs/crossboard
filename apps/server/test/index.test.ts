import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
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
import { accessibleRepos, hasRepoAccess } from "../src/access/index.js";
import { addUser, signIn } from "./sign-in.js";
import { accessHandlers, repoPayload, storeTokens } from "./access.js";
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

  it("serves an issue's details through the installation client the sync uses", async () => {
    stubEnv({ ...validEnv, ...githubEnv });
    const entry = await start();
    const { db } = entry.database;
    db.insert(schema.installations)
      .values({
        id: 1,
        accountLogin: "octocat",
        accountId: 1,
        accountType: "User",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const user = addUser(db, "octocat");
    db.insert(schema.userInstallations)
      .values({ userId: user.id, installationId: 1, computedAt: 1 })
      .run();
    db.insert(schema.repos)
      .values({
        id: "R_1",
        databaseId: 1,
        installationId: 1,
        owner: "octocat",
        name: "repo-1",
        private: true,
        syncState: "ready",
        openIssueCount: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.userRepoAccess)
      .values({ userId: user.id, repoId: "R_1", computedAt: 1 })
      .run();
    db.insert(schema.issues)
      .values({
        id: "I_1",
        databaseId: 1,
        repoId: "R_1",
        number: 1,
        title: "Issue 1",
        url: "https://github.com/octocat/repo-1/issues/1",
        authorLogin: "octocat",
        typeName: null,
        typeColor: null,
        milestoneTitle: null,
        milestoneUrl: null,
        parentId: null,
        subTotal: 0,
        subCompleted: 0,
        blockedByTotal: 0,
        blockingTotal: 0,
        createdAt: 1000,
        updatedAt: 1000,
        syncedAt: 1,
      })
      .run();
    const graphql = vi.spyOn(entry.installations, "graphql").mockResolvedValue({
      rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: null },
      node: {
        bodyHTML: "<p>the body</p>",
        comments: { totalCount: 0, nodes: [] },
        subIssues: { totalCount: 0, nodes: [] },
      },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/issues/octocat/repo-1/1/details`,
      { headers: { Cookie: signIn(db, user.id).cookie } },
    );

    expect(response.status).toBe(200);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0]?.[0]).toBe(1);
  });

  it("applies signed issue webhooks through the handlers the entry registers", async () => {
    stubEnv({ ...validEnv, ...githubEnv });
    const entry = await start();
    const { db } = entry.database;
    db.insert(schema.installations)
      .values({
        id: 1,
        accountLogin: "octocat",
        accountId: 1,
        accountType: "User",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(schema.repos)
      .values({
        id: "R_1",
        databaseId: 1,
        installationId: 1,
        owner: "octocat",
        name: "repo-1",
        private: true,
        syncState: "ready",
        openIssueCount: 2,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    for (const number of [1, 2]) {
      db.insert(schema.issues)
        .values({
          id: `I_${String(number)}`,
          databaseId: number,
          repoId: "R_1",
          number,
          title: `Issue ${String(number)}`,
          url: `https://github.com/octocat/repo-1/issues/${String(number)}`,
          subTotal: 0,
          subCompleted: 0,
          blockedByTotal: 0,
          blockingTotal: 0,
          createdAt: 1000,
          updatedAt: 1000,
          syncedAt: 1,
        })
        .run();
      db.insert(schema.issueDetails)
        .values({
          issueId: `I_${String(number)}`,
          bodyHtml: "<p>cached</p>",
          commentsJson: "[]",
          commentsTotal: 0,
          subIssuesJson: JSON.stringify({ total: 0, items: [] }),
          fetchedForUpdatedAt: 1000,
          fetchedAt: 1,
        })
        .run();
    }
    const send = (event: string, payload: object) => {
      const body = JSON.stringify({
        installation: { id: 1 },
        repository: { node_id: "R_1", private: true },
        ...payload,
      });
      return fetch(`http://127.0.0.1:${port}/webhooks/github`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": `delivery-${event}`,
          "X-Hub-Signature-256": `sha256=${createHmac("sha256", githubEnv.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`,
        },
      });
    };

    expect(
      (
        await send("issue_comment", {
          action: "created",
          issue: { node_id: "I_1" },
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await send("issues", {
          action: "deleted",
          issue: { node_id: "I_2" },
        })
      ).status,
    ).toBe(202);

    await vi.waitFor(() => {
      expect(
        db
          .select()
          .from(schema.issues)
          .all()
          .map((row) => row.id),
      ).toEqual(["I_1"]);
      expect(
        db
          .select()
          .from(schema.issueDetails)
          .all()
          .map((row) => row.issueId),
      ).toEqual([]);
    });
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

    it("purges the repositories of an installation an allowlist change deactivated before discovery runs", async () => {
      const ORG_INSTALLATION_ID = 20;
      const seed = openAndMigrate(dataDir);
      const { db } = seed;
      db.insert(schema.installations)
        .values([
          installationRow(INSTALLATION_ID, "octocat"),
          {
            ...installationRow(ORG_INSTALLATION_ID, "acme"),
            accountType: "Organization",
          },
          installationRow(30, "stranger"),
        ])
        .run();
      const carol = addUser(db, "carol");
      const octocat = addUser(db, "octocat");
      db.insert(schema.userInstallations)
        .values([
          {
            userId: carol.id,
            installationId: ORG_INSTALLATION_ID,
            computedAt: 1,
          },
          {
            userId: octocat.id,
            installationId: INSTALLATION_ID,
            computedAt: 1,
          },
        ])
        .run();
      const repoRow = (
        id: string,
        databaseId: number,
        installationId: number,
        owner: string,
      ) => ({
        id,
        databaseId,
        installationId,
        owner,
        name: "repo-1",
        private: false,
        syncState: id === "R_1" ? ("syncing" as const) : ("ready" as const),
        openIssueCount: 3,
        createdAt: 1,
        updatedAt: 1,
      });
      db.insert(schema.repos)
        .values([
          repoRow("R_1", 1, INSTALLATION_ID, "octocat"),
          repoRow("R_org", 2, ORG_INSTALLATION_ID, "acme"),
          repoRow("R_org_2", 3, ORG_INSTALLATION_ID, "acme-2"),
          repoRow("R_stranger", 4, 30, "stranger"),
        ])
        .run();
      const issueRow = (id: string, repoId: string, number: number) => ({
        id,
        databaseId: number + 100,
        repoId,
        number,
        title: id,
        url: "https://github.com/x/y/issues/1",
        subTotal: 0,
        subCompleted: 0,
        blockedByTotal: 0,
        blockingTotal: 0,
        createdAt: 1,
        updatedAt: 1,
        syncedAt: 1,
      });
      db.insert(schema.issues)
        .values([
          issueRow("I_1", "R_1", 1),
          issueRow("I_org", "R_org", 1),
          issueRow("I_stranger", "R_stranger", 1),
        ])
        .run();
      db.insert(schema.userRepoAccess)
        .values([
          { userId: carol.id, repoId: "R_org", computedAt: 1 },
          { userId: carol.id, repoId: "R_org_2", computedAt: 1 },
          { userId: octocat.id, repoId: "R_1", computedAt: 1 },
        ])
        .run();
      const board = db
        .insert(schema.boards)
        .values({
          userId: carol.id,
          name: "b",
          baseFilter: "repo:acme/repo",
          sort: "updated",
          subIssueMode: "flat",
          showOther: false,
          createdAt: 1,
          updatedAt: 1,
        })
        .returning()
        .get();
      db.insert(schema.boardColumns)
        .values({
          boardId: board.id,
          position: 0,
          name: "c",
          filter: "is:open",
        })
        .run();
      db.insert(schema.savedViews)
        .values({
          userId: carol.id,
          name: "v",
          filter: "repo:acme/repo",
          sort: "updated",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      seed.sqlite.close();
      stubEnv({
        ...discoveryEnv(),
        CROSSBOARD_ALLOWED_USERS: "octocat",
        CROSSBOARD_ALLOWED_ORGS: "",
      });
      const fake = createFakeGithub();
      fake.listen();
      fake.server.use(...repoWithIssues());
      try {
        const entry = await start();
        await until(() => readyWithIssues(entry));
        const ids = (table: string) =>
          entry.database.sqlite
            .prepare(`SELECT id FROM ${table} ORDER BY id`)
            .pluck()
            .all();
        expect(ids("repos")).toEqual(["R_1"]);
        expect(ids("issues")).toEqual(["I_1", "I_2", "I_3"]);
        expect(accessibleRepos(entry.database.db, carol.id)).toEqual([]);
        expect(hasRepoAccess(entry.database.db, carol.id, "R_org")).toBe(false);
        expect(
          accessibleRepos(entry.database.db, octocat.id).map(({ id }) => id),
        ).toEqual(["R_1"]);
        expect(ids("installations")).toEqual([
          INSTALLATION_ID,
          ORG_INSTALLATION_ID,
          30,
        ]);
        expect(ids("boards")).toEqual([board.id]);
        expect(ids("board_columns")).toHaveLength(1);
        expect(ids("saved_views")).toHaveLength(1);
        const purged = output
          .join("")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter(
            (record) =>
              record.msg ===
              "purged the repositories of inactive installations",
          );
        expect(purged).toHaveLength(1);
        expect(purged[0]).toMatchObject({
          level: 30,
          installations: [ORG_INSTALLATION_ID, 30],
          repos: 3,
        });
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

    it("removes the issues a resumed sync no longer returns", async () => {
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
          openIssueCount: 4,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      seed.db
        .insert(schema.issues)
        .values({
          id: "I_stale",
          databaseId: 99,
          repoId: "R_1",
          number: 99,
          title: "Deleted on GitHub",
          url: "https://github.test/octocat/repo-1/issues/99",
          subTotal: 0,
          subCompleted: 0,
          blockedByTotal: 0,
          blockingTotal: 0,
          createdAt: 1,
          updatedAt: 1,
          syncedAt: 1,
        })
        .run();
      seed.db
        .insert(schema.issueRefs)
        .values({
          id: "I_stale",
          repoFullName: "octocat/repo-1",
          number: 99,
          title: "Deleted on GitHub",
          state: "OPEN",
          url: "https://github.test/octocat/repo-1/issues/99",
          seenAt: 1,
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
        expect(issueIds(entry)).toEqual([
          { id: "I_1" },
          { id: "I_2" },
          { id: "I_3" },
        ]);
        expect(
          entry.database.sqlite.prepare("SELECT id FROM issue_refs").all(),
        ).toEqual([]);
      } finally {
        fake.close();
      }
    });

    it("schedules a daily discovery that recovers an installation whose discovery failed", async () => {
      const seed = openAndMigrate(dataDir);
      seed.db
        .insert(schema.installations)
        .values(installationRow(INSTALLATION_ID, "octocat"))
        .run();
      seed.sqlite.close();
      stubEnv(discoveryEnv());
      const fake = createFakeGithub();
      fake.listen();
      let failing = true;
      fake.server.use(
        ...repoWithIssues(),
        http.get(`${FAKE_API_URL}/installation/repositories`, () =>
          failing
            ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
            : undefined,
        ),
      );
      try {
        const entry = await start();
        const failures = () =>
          output
            .join("")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter(
              (record) =>
                record.level === 40 &&
                String(record.msg).startsWith("repository discovery failed"),
            );
        await until(() => failures().length > 0);
        expect(failures()[0]).toMatchObject({
          installationId: INSTALLATION_ID,
        });
        expect(repos(entry)).toEqual([]);

        failing = false;
        expect(() => entry.jobs.schedule("sync.discover-all", 1000)).toThrow(
          /already scheduled/,
        );
        expect(entry.jobs.enqueue("sync.discover-all", undefined)).toBe(true);
        await until(() => readyWithIssues(entry));
        expect(repos(entry)).toEqual([
          {
            id: "R_1",
            installation_id: INSTALLATION_ID,
            sync_state: "ready",
            open_issue_count: 3,
          },
        ]);
      } finally {
        fake.close();
      }
    });

    it("schedules the daily resync of the ready repositories", async () => {
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
          syncState: "ready",
          openIssueCount: 0,
          lastFullSyncAt: 1,
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
        expect(() => entry.jobs.schedule("sync.resync", 1000)).toThrow(
          /already scheduled/,
        );
        expect(issueIds(entry)).toEqual([]);
        expect(entry.jobs.enqueue("sync.resync", undefined)).toBe(true);
        await until(() => issueIds(entry).length === 3);
        expect(issueIds(entry)).toEqual([
          { id: "I_1" },
          { id: "I_2" },
          { id: "I_3" },
        ]);
      } finally {
        fake.close();
      }
    });

    it("schedules the reconciliation of the ready repositories", async () => {
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
          syncState: "ready",
          openIssueCount: 0,
          lastFullSyncAt: 1,
          reconcileSince: "2026-01-01T00:00:00.000Z",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      seed.sqlite.close();
      stubEnv(discoveryEnv());
      const fake = createFakeGithub();
      fake.listen();
      // The lookup by node id resolves issues for the installation that owns
      // the repo, which the fake names by its own token.
      repoWithIssues();
      (github.world.repos[0] as { installationId?: number }).installationId =
        INSTALLATION_ID;
      fake.server.use(...github.handlers);
      try {
        const entry = await start();
        expect(() => entry.jobs.schedule("sync.reconcile", 1000)).toThrow(
          /already scheduled/,
        );
        expect(issueIds(entry)).toEqual([]);
        expect(entry.jobs.enqueue("sync.reconcile", undefined)).toBe(true);
        await until(() => issueIds(entry).length === 3);
        expect(issueIds(entry)).toEqual([
          { id: "I_1" },
          { id: "I_2" },
          { id: "I_3" },
        ]);
        expect(
          entry.database.sqlite
            .prepare("SELECT last_reconciled_at FROM repos")
            .pluck()
            .get(),
        ).not.toBeNull();
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

    describe("a repository the hourly access job records first", () => {
      const seedActiveInstallation = () => {
        const seed = openAndMigrate(dataDir);
        const live = signIn(seed.db, addUser(seed.db, "octocat").id);
        storeTokens(seed.db, validEnv.CROSSBOARD_APP_SECRET, live.userId, {
          access: "ghu_octocat",
        });
        seed.db
          .insert(schema.installations)
          .values(installationRow(INSTALLATION_ID, "octocat"))
          .run();
        seed.sqlite.close();
        return live;
      };
      const reachable = (
        ...entries: { id: number; nodeId: string; name: string }[]
      ) =>
        accessHandlers({
          ghu_octocat: {
            installations: [{ id: INSTALLATION_ID, login: "octocat" }],
            repos: {
              [INSTALLATION_ID]: entries.map((entry) => ({
                ...entry,
                owner: "octocat",
              })),
            },
          },
        });

      it("is discovered and synced right away for an installation that was already active", async () => {
        seedActiveInstallation();
        stubEnv(discoveryEnv());
        const fake = createFakeGithub();
        fake.listen();
        let appeared = false;
        let listRequests = 0;
        fake.server.use(
          ...repoWithIssues(),
          ...reachable({ id: 1, nodeId: "R_1", name: "repo-1" }),
          http.get(`${FAKE_API_URL}/installation/repositories`, () => {
            listRequests++;
            return HttpResponse.json({
              total_count: 1,
              repositories: appeared
                ? [
                    repoPayload({
                      id: 1,
                      nodeId: "R_1",
                      owner: "octocat",
                      name: "repo-1",
                    }),
                  ]
                : [],
            });
          }),
        );
        try {
          const entry = await start();
          await until(() => listRequests > 0);
          appeared = true;
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
          expect(listRequests).toBe(2);
        } finally {
          fake.close();
        }
      });

      it("is removed again, with its access, when GitHub no longer lists it", async () => {
        const live = seedActiveInstallation();
        stubEnv(discoveryEnv());
        const fake = createFakeGithub();
        fake.listen();
        fake.server.use(
          ...repoWithIssues(),
          ...reachable(
            { id: 1, nodeId: "R_1", name: "repo-1" },
            { id: 9, nodeId: "R_9", name: "repo-9" },
          ),
        );
        try {
          const entry = await start();
          expect(entry.jobs.enqueue("access.compute", undefined)).toBe(true);
          const computed = () =>
            entry.database.sqlite
              .prepare("SELECT count(*) FROM user_installations")
              .pluck()
              .get() === 1;
          await until(
            () =>
              computed() && readyWithIssues(entry) && repos(entry).length === 1,
          );
          expect(repos(entry)).toEqual([
            {
              id: "R_1",
              installation_id: INSTALLATION_ID,
              sync_state: "ready",
              open_issue_count: 3,
            },
          ]);
          expect(
            entry.database.sqlite
              .prepare("SELECT user_id, repo_id FROM user_repo_access")
              .all(),
          ).toEqual([{ user_id: live.userId, repo_id: "R_1" }]);
        } finally {
          fake.close();
        }
      });
    });
  });

  it("gates a fresh instance behind the setup token it writes to the data directory", async () => {
    stubEnv(validEnv);
    await start();

    const file = join(dataDir, "setup-token");
    const token = readFileSync(file, "utf8").trim();
    expect(token).not.toBe("");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = output
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { level: number; msg: string });
    expect(lines.find((line) => line.msg.includes(file))?.level).toBe(40);
    expect(output.join("")).not.toContain(token);

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

  it("logs a fatal without the token and exits when the setup token file cannot be written", async () => {
    stubEnv(validEnv);
    mkdirSync(join(dataDir, "setup-token"));
    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    const record = JSON.parse(output.join("").trim().split("\n").pop() ?? "");
    expect(record.level).toBe(60);
    expect(output.join("")).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it("serves normally and logs no setup token when the environment has the App credentials", async () => {
    stubEnv({ ...validEnv, ...githubEnv });
    await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/issues`, {
      redirect: "manual",
    });
    expect(response.status).toBe(401);
    expect(output.join("")).not.toContain("setupToken");
    expect(existsSync(join(dataDir, "setup-token"))).toBe(false);
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

  describe("background pause rule", () => {
    const logLines = () =>
      output
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const suspendedInstallation = (suspended: boolean) => ({
      id: 1,
      accountLogin: "octocat",
      accountId: 1,
      accountType: "User" as const,
      suspended,
      createdAt: 1,
      updatedAt: 1,
    });

    it("drops the background jobs of a suspended installation and applies the delivery that lifts the suspension", async () => {
      stubEnv({ ...validEnv, ...githubEnv });
      const entry = await start();
      const { db } = entry.database;
      db.insert(schema.installations).values(suspendedInstallation(true)).run();
      const ran: string[] = [];
      entry.jobs.register<string>("probe", (tag) => void ran.push(tag));
      const send = (event: string, payload: object) => {
        const body = JSON.stringify({ installation: { id: 1 }, ...payload });
        return fetch(`http://127.0.0.1:${port}/webhooks/github`, {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "X-GitHub-Event": event,
            "X-GitHub-Delivery": `delivery-${event}`,
            "X-Hub-Signature-256": `sha256=${createHmac("sha256", githubEnv.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`,
          },
        });
      };
      const flag = () =>
        db
          .select({ suspended: schema.installations.suspended })
          .from(schema.installations)
          .get()?.suspended;

      entry.jobs.enqueue("probe", "while suspended", { installationId: 1 });
      expect(
        (
          await send("issue_comment", {
            action: "created",
            issue: { node_id: "I_1" },
          })
        ).status,
      ).toBe(202);
      await vi.waitFor(() => {
        expect(
          logLines().filter((line) => line.msg === "background job dropped"),
        ).toEqual([
          expect.objectContaining({
            job: "probe",
            installationId: 1,
            reason: "installation suspended",
          }),
          expect.objectContaining({
            job: "webhook:issue_comment",
            installationId: 1,
            reason: "installation suspended",
          }),
        ]);
      });
      expect(ran).toEqual([]);
      expect(flag()).toBe(true);

      expect(
        (
          await send("installation", {
            action: "unsuspend",
            installation: {
              id: 1,
              account: { id: 1, login: "octocat" },
              target_type: "User",
              suspended_at: null,
            },
          })
        ).status,
      ).toBe(202);
      await vi.waitFor(() => {
        expect(flag()).toBe(false);
      });

      entry.jobs.enqueue("probe", "after unsuspend", { installationId: 1 });
      await vi.waitFor(() => {
        expect(ran).toEqual(["after unsuspend"]);
      });
    });

    it("defers the background jobs of an installation below 10% of its budget until the reset", async () => {
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
        const resetAt = new Date(Date.now() + 400).toISOString();
        fake.server.use(
          http.post(`${FAKE_API_URL}/graphql`, () =>
            HttpResponse.json({
              data: {
                rateLimit: { cost: 1, remaining: 250, limit: 5000, resetAt },
                repository: { issues: { totalCount: 0, nodes: [] } },
              },
            }),
          ),
        );
        const entry = await start();
        await entry.installations.graphql(
          INSTALLATION_ID,
          queries.openIssuesPage,
          { owner: "octocat", name: "repo-1" },
        );
        const ran: string[] = [];
        entry.jobs.register<string>("probe", (tag) => void ran.push(tag));

        entry.jobs.enqueue("probe", "background", {
          installationId: INSTALLATION_ID,
        });
        entry.jobs.enqueue("probe", "interactive", {
          installationId: INSTALLATION_ID,
          kind: "interactive",
        });
        await vi.waitFor(() => {
          expect(ran).toEqual(["interactive"]);
        });
        expect(
          logLines().filter((line) => line.msg === "background job paused"),
        ).toEqual([
          expect.objectContaining({
            job: "probe",
            installationId: INSTALLATION_ID,
          }),
        ]);

        await vi.waitFor(
          () => {
            expect(ran).toEqual(["interactive", "background"]);
          },
          { timeout: 3_000 },
        );
      } finally {
        fake.close();
      }
    });
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
