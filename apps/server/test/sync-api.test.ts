import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_INTERVAL_MS } from "../src/api/sync.js";
import { schema } from "../src/db/index.js";
import type { Jobs } from "../src/jobs/index.js";
import { RECONCILE_REPO_JOB } from "../src/sync/reconcile.js";
import {
  ORIGIN,
  addInstallation,
  addRepo,
  buildApiApp,
  jsonHeaders,
} from "./api-app.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { unusedInstallations, unusedJobs } from "./helpers.js";
import { addUser, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-sync-"));
});

afterEach(() => {
  vi.useRealTimers();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function recordingJobs() {
  const enqueued: { name: string; payload: unknown; key?: string }[] = [];
  const jobs: Jobs = {
    ...unusedJobs,
    enqueue: (name, payload, options) => {
      enqueued.push({
        name,
        payload,
        ...(options?.key === undefined ? {} : { key: options.key }),
      });
      return true;
    },
  };
  return { jobs, enqueued };
}

function link(userId: number, installationId = 1) {
  database.db
    .insert(schema.userInstallations)
    .values({ userId, installationId, computedAt: 1 })
    .run();
}

function setRepo(
  id: string,
  fields: Partial<typeof schema.repos.$inferInsert>,
) {
  database.db
    .update(schema.repos)
    .set(fields)
    .where(eq(schema.repos.id, id))
    .run();
}

describe("GET /api/sync", () => {
  it("rejects a request without a session", async () => {
    const response = await buildApiApp(database, dir).request("/api/sync");
    expect(response.status).toBe(401);
  });

  it("returns each accessible repo's state and last sync time, and the oldest ready one", async () => {
    const alice = addUser(database.db, "octocat");
    addInstallation(database);
    link(alice.id);
    const fresh = addRepo(database, "acme", "fresh", [alice.id]);
    const old = addRepo(database, "acme", "old", [alice.id]);
    const failing = addRepo(database, "acme", "failing", [alice.id]);
    const skipped = addRepo(database, "acme", "skipped", [alice.id]);
    const pending = addRepo(database, "acme", "pending", [alice.id]);
    const syncing = addRepo(database, "acme", "syncing", [alice.id]);
    setRepo(fresh, { lastFullSyncAt: 1_000, lastReconciledAt: 5_000 });
    setRepo(old, { lastFullSyncAt: 3_000, lastReconciledAt: null });
    setRepo(failing, {
      syncState: "error",
      syncDetail: "GitHub answered 502",
      lastFullSyncAt: 100,
    });
    setRepo(skipped, {
      syncState: "skipped",
      syncDetail: "Repository is empty",
    });
    setRepo(pending, { syncState: "pending" });
    setRepo(syncing, { syncState: "syncing" });

    const response = await buildApiApp(database, dir).request("/api/sync", {
      headers: { Cookie: signIn(database.db, alice.id).cookie },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      syncedAt: number | null;
      repos: unknown[];
    };
    expect(body.syncedAt).toBe(3_000);
    expect(body.repos).toEqual([
      {
        owner: "acme",
        name: "failing",
        state: "error",
        detail: "GitHub answered 502",
        lastSyncedAt: 100,
      },
      {
        owner: "acme",
        name: "fresh",
        state: "ready",
        detail: null,
        lastSyncedAt: 5_000,
      },
      {
        owner: "acme",
        name: "old",
        state: "ready",
        detail: null,
        lastSyncedAt: 3_000,
      },
      {
        owner: "acme",
        name: "pending",
        state: "pending",
        detail: null,
        lastSyncedAt: null,
      },
      {
        owner: "acme",
        name: "skipped",
        state: "skipped",
        detail: "Repository is empty",
        lastSyncedAt: null,
      },
      {
        owner: "acme",
        name: "syncing",
        state: "syncing",
        detail: null,
        lastSyncedAt: null,
      },
    ]);
  });

  it("has no oldest time when no repo is ready or a ready repo has no time", async () => {
    const alice = addUser(database.db, "octocat");
    addInstallation(database);
    link(alice.id);
    const { cookie } = signIn(database.db, alice.id);
    const get = async () =>
      (
        (await (
          await buildApiApp(database, dir).request("/api/sync", {
            headers: { Cookie: cookie },
          })
        ).json()) as { syncedAt: number | null }
      ).syncedAt;

    expect(await get()).toBeNull();

    const timed = addRepo(database, "acme", "timed", [alice.id]);
    setRepo(timed, { lastFullSyncAt: 10 });
    addRepo(database, "acme", "untimed", [alice.id]);
    expect(await get()).toBeNull();
  });

  it("reports the budget of each active installation the user reaches, null until known", async () => {
    const alice = addUser(database.db, "octocat");
    addInstallation(database, 1);
    addInstallation(database, 2);
    addInstallation(database, 3);
    link(alice.id, 1);
    link(alice.id, 2);
    link(alice.id, 3);
    // Installation 3 is not active: no allowed account reaches it.
    database.db
      .update(schema.installations)
      .set({ accountLogin: "stranger" })
      .where(eq(schema.installations.id, 3))
      .run();
    database.db
      .delete(schema.userInstallations)
      .where(eq(schema.userInstallations.installationId, 3))
      .run();
    const stranger = addUser(database.db, "stranger-user");
    link(stranger.id, 3);

    const response = await buildApiApp(database, dir, {
      installations: {
        ...unusedInstallations,
        budgets: {
          get: (id) =>
            id === 1
              ? {
                  rest: { remaining: 4_000, limit: 5_000, resetAt: 9_000 },
                  graphql: { remaining: 100, limit: null, resetAt: null },
                }
              : { rest: null, graphql: null },
        },
      },
    }).request("/api/sync", {
      headers: { Cookie: signIn(database.db, alice.id).cookie },
    });

    const body = (await response.json()) as { installations: unknown[] };
    expect(body.installations).toEqual([
      {
        id: 1,
        accountLogin: "account1",
        rest: { remaining: 4_000, limit: 5_000, resetAt: 9_000 },
        graphql: { remaining: 100, limit: null, resetAt: null },
      },
      { id: 2, accountLogin: "account2", rest: null, graphql: null },
    ]);
  });

  it("never shows a second user another user's repos, installations or times", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bobby");
    addInstallation(database, 1);
    addInstallation(database, 2);
    link(alice.id, 1);
    link(alice.id, 2);
    link(bob.id, 2);
    const secret = addRepo(database, "acme", "secret", [alice.id]);
    setRepo(secret, { lastFullSyncAt: 1, syncDetail: "private detail" });
    const bobs = addRepo(database, "bobs", "repo", [bob.id]);
    setRepo(bobs, { installationId: 2, lastFullSyncAt: 9 });

    const asBob = await buildApiApp(database, dir).request("/api/sync", {
      headers: { Cookie: signIn(database.db, bob.id).cookie },
    });
    const text = await asBob.text();

    const body = JSON.parse(text) as {
      syncedAt: number | null;
      repos: { name: string }[];
      installations: { id: number }[];
    };
    expect(body.repos.map((repo) => repo.name)).toEqual(["repo"]);
    expect(body.installations.map((entry) => entry.id)).toEqual([2]);
    expect(body.syncedAt).toBe(9);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private detail");
  });
});

describe("POST /api/sync/refresh", () => {
  function seed() {
    const alice = addUser(database.db, "octocat");
    addInstallation(database);
    link(alice.id);
    return alice;
  }

  const refresh = (app: ReturnType<typeof buildApiApp>, cookie: string) =>
    app.request("/api/sync/refresh", {
      method: "POST",
      headers: jsonHeaders(cookie),
    });

  it("enqueues a reconciliation of the user's ready repos in active installations only", async () => {
    const alice = seed();
    const bob = addUser(database.db, "bobby");
    const a = addRepo(database, "acme", "a", [alice.id]);
    const b = addRepo(database, "acme", "b", [alice.id]);
    const pending = addRepo(database, "acme", "pending", [alice.id]);
    setRepo(pending, { syncState: "pending" });
    addRepo(database, "acme", "bobs", [bob.id]);
    const { jobs, enqueued } = recordingJobs();

    const response = await refresh(
      buildApiApp(database, dir, { jobs }),
      signIn(database.db, alice.id).cookie,
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ repos: 2 });
    expect(enqueued.map((job) => job.name)).toEqual([
      RECONCILE_REPO_JOB,
      RECONCILE_REPO_JOB,
    ]);
    expect(enqueued.map((job) => job.key).sort()).toEqual([a, b].sort());
  });

  it("does not enqueue repos of an installation that is not active", async () => {
    const alice = addUser(database.db, "octocat");
    addInstallation(database);
    // No allowed account reaches installation 1 except through this stranger.
    database.db
      .update(schema.installations)
      .set({ accountLogin: "stranger" })
      .run();
    const stranger = addUser(database.db, "stranger-user");
    link(stranger.id);
    addRepo(database, "acme", "a", [alice.id]);
    const { jobs, enqueued } = recordingJobs();

    const response = await refresh(
      buildApiApp(database, dir, { jobs }),
      signIn(database.db, alice.id).cookie,
    );

    expect(response.status).toBe(202);
    expect(enqueued).toEqual([]);
  });

  it("answers 429 with the remaining seconds inside 60 s, then accepts again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const alice = seed();
    addRepo(database, "acme", "a", [alice.id]);
    const { jobs, enqueued } = recordingJobs();
    const app = buildApiApp(database, dir, { jobs });
    const { cookie } = signIn(database.db, alice.id);

    expect((await refresh(app, cookie)).status).toBe(202);
    vi.setSystemTime(1_000_000 + 20_000);
    const limited = await refresh(app, cookie);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("40");
    expect(await limited.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Refresh again in 40 s",
        retryAfter: 40,
      },
    });
    expect(enqueued).toHaveLength(1);

    vi.setSystemTime(1_000_000 + REFRESH_INTERVAL_MS);
    expect((await refresh(app, cookie)).status).toBe(202);
    expect(enqueued).toHaveLength(2);
  });

  it("limits each user separately", async () => {
    const alice = seed();
    const bob = addUser(database.db, "bobby");
    link(bob.id);
    const app = buildApiApp(database, dir);

    expect(
      (await refresh(app, signIn(database.db, alice.id).cookie)).status,
    ).toBe(202);
    expect(
      (await refresh(app, signIn(database.db, bob.id).cookie)).status,
    ).toBe(202);
    expect(
      (await refresh(app, signIn(database.db, alice.id).cookie)).status,
    ).toBe(429);
  });

  it("rejects a request without a session, a foreign Origin or a non-JSON body, with nothing enqueued", async () => {
    const alice = seed();
    addRepo(database, "acme", "a", [alice.id]);
    const { jobs, enqueued } = recordingJobs();
    const app = buildApiApp(database, dir, { jobs });
    const { cookie } = signIn(database.db, alice.id);

    const anonymous = await app.request("/api/sync/refresh", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    });
    const foreign = await app.request("/api/sync/refresh", {
      method: "POST",
      headers: { ...jsonHeaders(cookie), Origin: "https://evil.example" },
    });
    const missing = await app.request("/api/sync/refresh", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const form = await app.request("/api/sync/refresh", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    expect(anonymous.status).toBe(401);
    expect(foreign.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(form.status).toBe(415);
    expect(enqueued).toEqual([]);
    expect((await refresh(app, cookie)).status).toBe(202);
  });
});
