import { eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { activeInstallationIds } from "../src/access/active.js";
import { createAccess } from "../src/access/compute.js";
import {
  ACCESS_INTERVAL_MS,
  ACCESS_JOB,
  registerAccessJob,
} from "../src/access/job.js";
import {
  accessibleRepos,
  hasRepoAccess,
  inUserAccess,
} from "../src/access/scope.js";
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { SESSION_TTL_MS, createSession } from "../src/auth/sessions/index.js";
import { createUserTokens } from "../src/auth/tokens.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import { decrypt, encrypt } from "../src/security/index.js";
import {
  accessHandlers,
  installationPayload,
  storeTokens,
  type World,
  type WorldRepo,
} from "./access.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { createFakeGithub, FAKE_API_URL, FAKE_WEB_URL } from "./github-fake.js";
import { githubEnv, validEnv } from "./helpers.js";
import { addUser, signIn } from "./sign-in.js";

const APP_SECRET = "a".repeat(32);
const ALICE = "ghu_alice_token";
const BOB = "ghu_bob_token";

const fake = createFakeGithub();
beforeAll(() => fake.listen());
afterAll(() => fake.close());

let database: TestDatabase;
let logs: Record<string, unknown>[];
let worlds: Record<string, World>;

beforeEach(() => {
  database = createTestDatabase();
  logs = [];
  worlds = {};
  fake.server.use(...accessHandlers(worlds));
});

afterEach(() => {
  fake.reset();
  database.cleanup();
  vi.useRealTimers();
});

const repo = (
  id: number,
  owner: string,
  name: string,
  extra: Partial<WorldRepo> = {},
): WorldRepo => ({ id, nodeId: `R_${String(id)}`, owner, name, ...extra });

function build(
  allowlist = { users: ["alice", "bob"], orgs: [] as string[] },
  now?: () => number,
  onActivated?: (installationIds: number[]) => void,
) {
  const logger = createLogger("trace", {
    write: (chunk) => logs.push(JSON.parse(chunk)),
  });
  const github = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    sleep: () => Promise.resolve(),
    logger,
  });
  const tokens = createUserTokens({
    db: database.db,
    github,
    credentials: () => ({
      appId: "1",
      appSlug: "x",
      clientId: "Iv1.fakeclient",
      clientSecret: "fake-client-secret-value",
      privateKey: "k",
      webhookSecret: "w",
    }),
    appSecret: APP_SECRET,
    logger,
    ...(now === undefined ? {} : { now }),
  });
  const access = createAccess({
    db: database.db,
    github,
    tokens,
    allowlist,
    logger,
    ...(onActivated === undefined ? {} : { onActivated }),
    ...(now === undefined ? {} : { now }),
  });
  return { access, tokens, logger, github };
}

/** The real app over the same database, to ask what a session still reaches. */
function appFor({
  access,
  github,
  logger,
}: Pick<ReturnType<typeof build>, "access" | "github" | "logger">) {
  const config = loadConfig({ ...validEnv, ...githubEnv });
  return createApp({
    logger,
    db: database.db,
    github,
    version: "1.0.0",
    webRoot: "/nonexistent",
    setup: createSetup({ db: database.db, config, logger }),
    access,
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
  });
}

const tokensOf = (userId: number) =>
  database.db
    .select()
    .from(schema.userTokens)
    .where(eq(schema.userTokens.userId, userId))
    .all();

const sessionsOf = (userId: number) =>
  database.db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .all();

function userWithToken(login: string, token: string) {
  const user = addUser(database.db, login);
  storeTokens(database.db, APP_SECRET, user.id, { access: token });
  return user;
}

const accessOf = (userId: number) =>
  database.db
    .select({ repoId: schema.userRepoAccess.repoId })
    .from(schema.userRepoAccess)
    .where(eq(schema.userRepoAccess.userId, userId))
    .all()
    .map((row) => row.repoId)
    .sort();

const installationsOf = (userId: number) =>
  database.db
    .select({ id: schema.userInstallations.installationId })
    .from(schema.userInstallations)
    .where(eq(schema.userInstallations.userId, userId))
    .all()
    .map((row) => row.id)
    .sort();

describe("scoping helpers", () => {
  function seed() {
    const alice = addUser(database.db, "alice");
    const bob = addUser(database.db, "bob");
    database.db
      .insert(schema.installations)
      .values({
        id: 1,
        accountLogin: "acme",
        accountId: 1,
        accountType: "Organization",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    for (const [id, name] of [
      ["R_a", "only-alice"],
      ["R_shared", "shared"],
      ["R_b", "only-bob"],
    ] as const) {
      database.db
        .insert(schema.repos)
        .values({
          id,
          databaseId: id.length * 7 + name.length,
          installationId: 1,
          owner: "acme",
          name,
          private: true,
          syncState: "ready",
          openIssueCount: 0,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      database.db
        .insert(schema.issues)
        .values({
          id: `I_${id}`,
          databaseId: id.length,
          repoId: id,
          number: 1,
          title: `issue in ${name}`,
          url: "https://github.test/x",
          subTotal: 0,
          subCompleted: 0,
          blockedByTotal: 0,
          blockingTotal: 0,
          createdAt: 1,
          updatedAt: 1,
          syncedAt: 1,
        })
        .run();
    }
    const grant = (userId: number, repoId: string) =>
      database.db
        .insert(schema.userRepoAccess)
        .values({ userId, repoId, computedAt: 1 })
        .run();
    grant(alice.id, "R_a");
    grant(alice.id, "R_shared");
    grant(bob.id, "R_b");
    grant(bob.id, "R_shared");
    return { alice, bob };
  }

  it("returns a user only the repos in their own access", () => {
    const { alice, bob } = seed();
    expect(
      accessibleRepos(database.db, alice.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["R_a", "R_shared"]);
    expect(
      accessibleRepos(database.db, bob.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["R_b", "R_shared"]);
    expect(hasRepoAccess(database.db, alice.id, "R_b")).toBe(false);
    expect(hasRepoAccess(database.db, bob.id, "R_a")).toBe(false);
    expect(hasRepoAccess(database.db, alice.id, "R_shared")).toBe(true);
  });

  it("restricts a query over per-repo data to the user's access", () => {
    const { alice, bob } = seed();
    const titles = (userId: number) =>
      database.db
        .select({ title: schema.issues.title })
        .from(schema.issues)
        .where(inUserAccess(database.db, userId, schema.issues.repoId))
        .all()
        .map((row) => row.title)
        .sort();
    expect(titles(alice.id)).toEqual([
      "issue in only-alice",
      "issue in shared",
    ]);
    expect(titles(bob.id)).toEqual(["issue in only-bob", "issue in shared"]);
  });

  it("gives a user with no access nothing", () => {
    seed();
    const stranger = addUser(database.db, "stranger");
    expect(accessibleRepos(database.db, stranger.id)).toEqual([]);
    expect(hasRepoAccess(database.db, stranger.id, "R_shared")).toBe(false);
  });
});

describe("computing access", () => {
  it("stores each user's installations and repos and never the other user's", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    const bob = userWithToken("bob", BOB);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes"), repo(11, "alice", "dots")] },
    };
    worlds[BOB] = {
      installations: [{ id: 2, login: "bob" }],
      repos: { 2: [repo(20, "bob", "secret", { private: true })] },
    };

    expect(await access.compute(alice.id)).toBe("computed");
    expect(await access.compute(bob.id)).toBe("computed");

    expect(accessOf(alice.id)).toEqual(["R_10", "R_11"]);
    expect(accessOf(bob.id)).toEqual(["R_20"]);
    expect(installationsOf(alice.id)).toEqual([1]);
    expect(installationsOf(bob.id)).toEqual([2]);
    expect(
      accessibleRepos(database.db, alice.id).map((row) => row.name),
    ).not.toContain("secret");
  });

  it("upserts the installations it sees", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [
        { id: 1, login: "alice" },
        { id: 3, login: "acme", type: "Organization", suspended: true },
      ],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice-renamed" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);

    const rows = database.db.select().from(schema.installations).all();
    expect(rows.map((row) => row.id).sort()).toEqual([1, 3]);
    expect(rows.find((row) => row.id === 1)).toMatchObject({
      accountLogin: "alice-renamed",
      accountId: 1001,
      accountType: "User",
      suspended: false,
    });
    expect(rows.find((row) => row.id === 3)).toMatchObject({
      accountLogin: "acme",
      accountType: "Organization",
      suspended: true,
    });
  });

  it("inserts a new repo with identity fields only and sync_state pending", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes", { private: true })] },
    };
    await access.compute(alice.id);

    expect(database.db.select().from(schema.repos).all()).toEqual([
      {
        id: "R_10",
        databaseId: 10,
        installationId: 1,
        owner: "alice",
        name: "notes",
        private: true,
        syncState: "pending",
        syncDetail: null,
        openIssueCount: 0,
        lastFullSyncAt: null,
        lastReconciledAt: null,
        reconcileSince: null,
        restEtag: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("leaves the sync fields of a repo that already exists alone", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);
    database.db
      .update(schema.repos)
      .set({
        syncState: "ready",
        syncDetail: "ok",
        openIssueCount: 7,
        lastFullSyncAt: 5,
        restEtag: "etag",
      })
      .run();
    const before = database.db.select().from(schema.repos).all();

    await access.compute(alice.id);

    expect(database.db.select().from(schema.repos).all()).toEqual(before);
    expect(accessOf(alice.id)).toEqual(["R_10"]);
  });

  it("gives a second user access to a repo another user already brought in", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    const bob = userWithToken("bob", BOB);
    const shared = repo(30, "acme", "shared", { private: true });
    worlds[ALICE] = {
      installations: [{ id: 5, login: "acme", type: "Organization" }],
      repos: { 5: [shared] },
    };
    worlds[BOB] = {
      installations: [{ id: 5, login: "acme", type: "Organization" }],
      repos: { 5: [shared] },
    };
    await access.compute(alice.id);
    await access.compute(bob.id);

    expect(database.db.select().from(schema.repos).all()).toHaveLength(1);
    expect(accessOf(alice.id)).toEqual(["R_30"]);
    expect(accessOf(bob.id)).toEqual(["R_30"]);
  });

  it("replaces the user's previous access, dropping what GitHub no longer returns", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    const bob = userWithToken("bob", BOB);
    worlds[ALICE] = {
      installations: [
        { id: 1, login: "alice" },
        { id: 5, login: "acme", type: "Organization" },
      ],
      repos: { 1: [repo(10, "alice", "notes")], 5: [repo(30, "acme", "app")] },
    };
    worlds[BOB] = {
      installations: [{ id: 5, login: "acme", type: "Organization" }],
      repos: { 5: [repo(30, "acme", "app")] },
    };
    await access.compute(alice.id);
    await access.compute(bob.id);

    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [] },
    };
    await access.compute(alice.id);

    expect(accessOf(alice.id)).toEqual([]);
    expect(installationsOf(alice.id)).toEqual([1]);
    expect(accessOf(bob.id)).toEqual(["R_30"]);
    expect(installationsOf(bob.id)).toEqual([5]);
  });

  it("records a suspended installation but grants no repos through it", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice", suspended: true }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);
    expect(installationsOf(alice.id)).toEqual([1]);
    expect(accessOf(alice.id)).toEqual([]);
    expect(database.db.select().from(schema.repos).all()).toEqual([]);
  });

  it("leaves the stored access untouched when GitHub fails part-way", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);

    worlds[ALICE] = {
      installations: [
        { id: 1, login: "alice" },
        { id: 2, login: "acme", type: "Organization" },
      ],
      repos: { 1: [], 2: [repo(40, "acme", "app")] },
      failing: [2],
    };
    await expect(access.compute(alice.id)).rejects.toThrow(/500/);

    expect(accessOf(alice.id)).toEqual(["R_10"]);
    expect(installationsOf(alice.id)).toEqual([1]);
    expect(database.db.select().from(schema.installations).all()).toHaveLength(
      1,
    );
  });

  it("leaves a repo out of the access when it clashes with a stored repo", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);
    // The same name under a new node id, as after a delete and re-create.
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: {
        1: [repo(10, "alice", "notes"), repo(99, "alice", "notes")],
      },
    };
    await access.compute(alice.id);
    expect(accessOf(alice.id)).toEqual(["R_10"]);
  });

  it("skips a user without stored tokens and writes nothing", async () => {
    const { access } = build();
    const alice = addUser(database.db, "alice");
    expect(await access.compute(alice.id)).toBe("skipped");
    expect(fake.requests).toEqual([]);
    expect(accessOf(alice.id)).toEqual([]);
  });

  it("never logs a token", async () => {
    const { access } = build();
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    await access.compute(alice.id);
    expect(JSON.stringify(logs)).not.toContain(ALICE);
  });
});

describe("the active installations", () => {
  const setLinks = async (login: string, token: string, world: World) => {
    worlds[token] = world;
    const user = userWithToken(login, token);
    return user;
  };

  it("includes an installation whose account is in either allowlist, with no user", () => {
    const allowlist = { users: ["alice"], orgs: ["acme"] };
    for (const [id, login] of [
      [1, "Alice"],
      [2, "ACME"],
      [3, "other"],
    ] as const) {
      database.db
        .insert(schema.installations)
        .values({
          id,
          accountLogin: login,
          accountId: id,
          accountType: "User",
          suspended: false,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
    }
    expect([...activeInstallationIds(database.db, allowlist)].sort()).toEqual([
      1, 2,
    ]);
  });

  it("includes an installation that an allowed user's access includes", async () => {
    const allowlist = { users: ["alice"], orgs: [] as string[] };
    const { access } = build(allowlist);
    const alice = await setLinks("Alice", ALICE, {
      installations: [
        { id: 1, login: "alice" },
        { id: 5, login: "friend-org", type: "Organization" },
      ],
      repos: { 1: [], 5: [] },
    });
    await access.compute(alice.id);
    expect([...activeInstallationIds(database.db, allowlist)].sort()).toEqual([
      1, 5,
    ]);
  });

  it("includes an installation reached by a user allowed through an allowed org", async () => {
    const allowlist = { users: [] as string[], orgs: ["acme"] };
    const { access } = build(allowlist);
    const carol = await setLinks("carol", "ghu_c", {
      installations: [
        { id: 2, login: "acme", type: "Organization" },
        { id: 6, login: "carol" },
      ],
      repos: { 2: [], 6: [] },
    });
    await access.compute(carol.id);
    expect([...activeInstallationIds(database.db, allowlist)].sort()).toEqual([
      2, 6,
    ]);
  });

  it("leaves out an installation that only a non-allowed user reaches", async () => {
    const allowlist = { users: ["alice"], orgs: [] as string[] };
    const { access } = build(allowlist);
    const mallory = await setLinks("mallory", "ghu_m", {
      installations: [{ id: 9, login: "mallory-org", type: "Organization" }],
      repos: { 9: [] },
    });
    await access.compute(mallory.id);
    expect(activeInstallationIds(database.db, allowlist).size).toBe(0);
  });

  it("is recomputed by every access computation: an installation drops out once nobody allowed reaches it", async () => {
    const allowlist = { users: ["alice"], orgs: [] as string[] };
    const { access } = build(allowlist);
    const alice = await setLinks("alice", ALICE, {
      installations: [{ id: 5, login: "friend-org", type: "Organization" }],
      repos: { 5: [] },
    });
    await access.compute(alice.id);
    expect(activeInstallationIds(database.db, allowlist).has(5)).toBe(true);
    worlds[ALICE] = { installations: [], repos: {} };
    await access.compute(alice.id);
    expect(activeInstallationIds(database.db, allowlist).has(5)).toBe(false);
    expect(
      logs.some(
        (entry) =>
          entry.msg === "user access computed" &&
          JSON.stringify(entry.deactivated) === "[5]",
      ),
    ).toBe(true);
  });
});

describe("an installation that becomes or stops being active", () => {
  const allowlist = { users: ["alice", "bob"], orgs: [] as string[] };
  const org = (id: number) => ({
    id,
    login: `org-${String(id)}`,
    type: "Organization" as const,
  });

  function seedData(repoId: string) {
    const owner = repoId;
    for (const [id, number] of [
      [`I_${owner}_1`, 1],
      [`I_${owner}_2`, 2],
    ] as const) {
      database.db
        .insert(schema.issues)
        .values({
          id,
          databaseId: number,
          repoId,
          number,
          title: `issue ${String(number)}`,
          url: "https://github.test/x",
          subTotal: 0,
          subCompleted: 0,
          blockedByTotal: 0,
          blockingTotal: 0,
          createdAt: 1,
          updatedAt: 1,
          syncedAt: 1,
        })
        .run();
    }
    database.db
      .insert(schema.labels)
      .values({ id: `L_${owner}`, repoId, name: "bug", color: "d73a4a" })
      .run();
    database.db
      .insert(schema.issueLabels)
      .values({ issueId: `I_${owner}_1`, labelId: `L_${owner}` })
      .run();
    database.db
      .insert(schema.issueAssignees)
      .values({ issueId: `I_${owner}_1`, login: "x", avatarUrl: "u" })
      .run();
    database.db
      .insert(schema.issueDeps)
      .values([
        { blockedId: `I_${owner}_1`, blockingId: "I_elsewhere" },
        { blockedId: "I_elsewhere", blockingId: `I_${owner}_1` },
      ])
      .run();
  }

  const count = (table: SQLiteTable) =>
    database.db.select().from(table).all().length;

  it("purges the repos of an installation nobody allowed reaches any more, and only those", async () => {
    const { access } = build(allowlist);
    const alice = userWithToken("alice", ALICE);
    const bob = userWithToken("bob", BOB);
    worlds[ALICE] = {
      installations: [org(5), org(6)],
      repos: {
        5: [repo(50, "org-5", "tracker", { private: true })],
        6: [repo(60, "org-6", "tracker", { private: true })],
      },
    };
    worlds[BOB] = {
      installations: [org(5), org(6)],
      repos: {
        5: [repo(50, "org-5", "tracker", { private: true })],
        6: [repo(60, "org-6", "tracker", { private: true })],
      },
    };
    await access.compute(alice.id);
    await access.compute(bob.id);
    seedData("R_50");
    seedData("R_60");
    const gone = "R_50";
    const kept = "R_60";
    const board = database.db
      .insert(schema.boards)
      .values({
        userId: alice.id,
        name: "mine",
        baseFilter: "repo:org-5/tracker",
        sort: "updated",
        subIssueMode: "flat",
        showOther: true,
        createdAt: 1,
        updatedAt: 1,
      })
      .returning()
      .get();
    database.db
      .insert(schema.boardColumns)
      .values({
        boardId: board.id,
        position: 0,
        name: "bugs",
        filter: "label:bug",
      })
      .run();
    database.db
      .insert(schema.savedViews)
      .values({
        userId: bob.id,
        name: "view",
        filter: "repo:org-5/tracker",
        sort: "updated",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    worlds[ALICE] = {
      installations: [org(6)],
      repos: { 6: [repo(60, "org-6", "tracker")] },
    };
    await access.compute(alice.id);
    expect(hasRepoAccess(database.db, bob.id, gone)).toBe(true);
    expect(accessibleRepos(database.db, bob.id).map((row) => row.id)).toContain(
      gone,
    );

    worlds[BOB] = {
      installations: [org(6)],
      repos: { 6: [repo(60, "org-6", "tracker")] },
    };
    await access.compute(bob.id);

    for (const user of [alice, bob]) {
      expect(
        accessibleRepos(database.db, user.id).map((row) => row.id),
      ).toEqual([kept]);
      expect(hasRepoAccess(database.db, user.id, gone)).toBe(false);
      expect(
        database.db
          .select({ id: schema.issues.id })
          .from(schema.issues)
          .where(inUserAccess(database.db, user.id, schema.issues.repoId))
          .all()
          .map((row) => row.id)
          .sort(),
      ).toEqual(["I_R_60_1", "I_R_60_2"]);
    }
    expect(
      database.db
        .select()
        .from(schema.repos)
        .where(eq(schema.repos.id, gone))
        .all(),
    ).toEqual([]);
    expect(
      database.db
        .select()
        .from(schema.issues)
        .where(eq(schema.issues.repoId, gone))
        .all(),
    ).toEqual([]);
    expect(
      database.db
        .select()
        .from(schema.labels)
        .where(eq(schema.labels.repoId, gone))
        .all(),
    ).toEqual([]);
    expect(count(schema.issueLabels)).toBe(1);
    expect(count(schema.issueAssignees)).toBe(1);
    expect(
      database.db
        .select()
        .from(schema.issueDeps)
        .all()
        .map((row) => `${row.blockedId}>${row.blockingId}`)
        .sort(),
    ).toEqual([
      "I_R_60_1>I_elsewhere",
      "I_elsewhere>I_R_50_1",
      "I_elsewhere>I_R_60_1",
    ]);
    expect(count(schema.boards)).toBe(1);
    expect(count(schema.boardColumns)).toBe(1);
    expect(count(schema.savedViews)).toBe(1);
    expect(
      database.db
        .select()
        .from(schema.installations)
        .all()
        .map((row) => row.id)
        .sort(),
    ).toEqual([5, 6]);
    expect(
      logs.some(
        (entry) => entry.msg === "user access computed" && entry.purged === 1,
      ),
    ).toBe(true);
  });

  it("leaves everything in place when the installation stays active through another user", async () => {
    const { access } = build(allowlist);
    const alice = userWithToken("alice", ALICE);
    const bob = userWithToken("bob", BOB);
    const world = {
      installations: [org(5)],
      repos: { 5: [repo(50, "org-5", "tracker")] },
    };
    worlds[ALICE] = world;
    worlds[BOB] = world;
    await access.compute(alice.id);
    await access.compute(bob.id);
    seedData("R_50");
    const kept = "R_50";
    worlds[ALICE] = { installations: [], repos: {} };
    await access.compute(alice.id);
    expect(accessibleRepos(database.db, bob.id).map((row) => row.id)).toEqual([
      kept,
    ]);
    expect(count(schema.issues)).toBe(2);
  });

  it("purges nothing for an installation that was never active", async () => {
    const { access } = build({ users: ["alice"], orgs: [] });
    const mallory = userWithToken("mallory", "ghu_m");
    worlds.ghu_m = {
      installations: [org(9)],
      repos: { 9: [repo(90, "org-9", "tracker")] },
    };
    await access.compute(mallory.id);
    seedData("R_90");
    await access.compute(mallory.id);
    expect(count(schema.repos)).toBe(1);
    expect(count(schema.issues)).toBe(2);
  });

  it("rolls the purge back with the access it belongs to when it fails", async () => {
    const { access } = build(allowlist);
    const alice = userWithToken("alice", ALICE);
    worlds[ALICE] = {
      installations: [org(5)],
      repos: { 5: [repo(50, "org-5", "tracker")] },
    };
    await access.compute(alice.id);
    seedData("R_50");
    database.sqlite.exec(
      "CREATE TRIGGER block_purge BEFORE DELETE ON repos BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    worlds[ALICE] = { installations: [], repos: {} };
    await expect(access.compute(alice.id)).rejects.toThrow();
    expect(accessOf(alice.id)).toEqual(["R_50"]);
    expect(installationsOf(alice.id)).toEqual([5]);
    expect(count(schema.issues)).toBe(2);
  });

  it("reports the installations a computation made active, once", async () => {
    const activated: number[][] = [];
    const { access } = build(allowlist, undefined, (ids) =>
      activated.push(ids),
    );
    const alice = userWithToken("alice", ALICE);
    const mallory = userWithToken("mallory", "ghu_m");
    worlds[ALICE] = { installations: [org(5)], repos: { 5: [] } };
    worlds.ghu_m = { installations: [org(9)], repos: { 9: [] } };
    await access.compute(mallory.id);
    expect(activated).toEqual([]);
    await access.compute(alice.id);
    expect(activated).toEqual([[5]]);
    await access.compute(alice.id);
    expect(activated).toEqual([[5]]);
  });
});

describe("the hourly job", () => {
  it("computes the access of users with a live session and skips the others", async () => {
    const { access, logger } = build();
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);

    const live = signIn(database.db, userWithToken("alice", ALICE).id);
    const lapsed = userWithToken("bob", BOB);
    createSession(database.db, lapsed.id, Date.now() - SESSION_TTL_MS - 1);
    const sessionless = userWithToken("carol", "ghu_c");
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    worlds[BOB] = {
      installations: [{ id: 2, login: "bob" }],
      repos: { 2: [repo(20, "bob", "secret")] },
    };
    worlds["ghu_c"] = {
      installations: [{ id: 3, login: "carol" }],
      repos: { 3: [repo(30, "carol", "x")] },
    };

    jobs.start();
    jobs.enqueue(ACCESS_JOB, undefined);
    await jobs.stop();

    expect(accessOf(live.userId)).toEqual(["R_10"]);
    expect(accessOf(lapsed.id)).toEqual([]);
    expect(accessOf(sessionless.id)).toEqual([]);
  });

  it("goes on with the other users when one fails", async () => {
    const { access, logger } = build();
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);
    const first = signIn(database.db, userWithToken("alice", ALICE).id);
    const second = signIn(database.db, userWithToken("bob", BOB).id);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
      failing: [1],
    };
    worlds[BOB] = {
      installations: [{ id: 2, login: "bob" }],
      repos: { 2: [repo(20, "bob", "secret")] },
    };

    jobs.start();
    jobs.enqueue(ACCESS_JOB, undefined);
    await jobs.stop();

    expect(accessOf(first.userId)).toEqual([]);
    expect(accessOf(second.userId)).toEqual(["R_20"]);
    expect(
      logs.some((entry) => entry.msg === "computing user access failed"),
    ).toBe(true);
  });

  it("signs a user out when GitHub rejects their token with 401, and leaves the other users signed in", async () => {
    const built = build();
    const { access, logger } = built;
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);
    const alice = signIn(database.db, userWithToken("alice", "ghu_revoked").id);
    const bob = signIn(database.db, userWithToken("bob", BOB).id);
    worlds[BOB] = {
      installations: [{ id: 2, login: "bob" }],
      repos: { 2: [repo(20, "bob", "secret")] },
    };
    const app = appFor(built);
    expect(
      (await app.request("/api/me", { headers: { Cookie: alice.cookie } }))
        .status,
    ).toBe(200);

    jobs.start();
    jobs.enqueue(ACCESS_JOB, undefined);
    await jobs.stop();

    expect(tokensOf(alice.userId)).toEqual([]);
    expect(sessionsOf(alice.userId)).toEqual([]);
    expect(
      (await app.request("/api/me", { headers: { Cookie: alice.cookie } }))
        .status,
    ).toBe(401);
    expect(tokensOf(bob.userId)).toHaveLength(1);
    expect(sessionsOf(bob.userId)).toHaveLength(1);
    expect(
      (await app.request("/api/me", { headers: { Cookie: bob.cookie } }))
        .status,
    ).toBe(200);
    const warned = logs.filter(
      (entry) =>
        entry.level === 40 &&
        entry.msg ===
          "the user's GitHub tokens are no longer usable; their tokens and sessions were deleted",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ userId: alice.userId });
    expect(JSON.stringify(logs)).not.toContain("ghu_revoked");
  });

  it("signs a user out when the 401 comes from the repositories call", async () => {
    const { access, logger } = build();
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);
    const alice = signIn(database.db, userWithToken("alice", ALICE).id);
    fake.server.use(
      http.get(`${FAKE_API_URL}/user/installations`, () =>
        HttpResponse.json({
          total_count: 1,
          installations: [installationPayload({ id: 1, login: "alice" })],
        }),
      ),
      http.get(
        `${FAKE_API_URL}/user/installations/:installationId/repositories`,
        () =>
          HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );

    jobs.start();
    jobs.enqueue(ACCESS_JOB, undefined);
    await jobs.stop();

    expect(tokensOf(alice.userId)).toEqual([]);
    expect(sessionsOf(alice.userId)).toEqual([]);
  });

  it.each([403, 500, 502])(
    "keeps the tokens and sessions when GitHub answers %i",
    async (status) => {
      const { access, logger } = build();
      const jobs = createJobs({ logger });
      registerAccessJob(jobs, access, database.db, logger);
      const alice = signIn(database.db, userWithToken("alice", ALICE).id);
      fake.server.use(
        http.get(`${FAKE_API_URL}/user/installations`, () =>
          HttpResponse.json({ message: "no" }, { status }),
        ),
      );

      jobs.start();
      jobs.enqueue(ACCESS_JOB, undefined);
      await jobs.stop();

      expect(tokensOf(alice.userId)).toHaveLength(1);
      expect(sessionsOf(alice.userId)).toHaveLength(1);
      expect(
        logs.some((entry) => entry.msg === "computing user access failed"),
      ).toBe(true);
    },
  );

  it("keeps the tokens and sessions when the request fails on the network", async () => {
    const { access, logger } = build();
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);
    const alice = signIn(database.db, userWithToken("alice", ALICE).id);
    fake.server.use(
      http.get(`${FAKE_API_URL}/user/installations`, () =>
        HttpResponse.error(),
      ),
    );

    jobs.start();
    jobs.enqueue(ACCESS_JOB, undefined);
    await jobs.stop();

    expect(tokensOf(alice.userId)).toHaveLength(1);
    expect(sessionsOf(alice.userId)).toHaveLength(1);
    expect(
      logs.some((entry) => entry.msg === "computing user access failed"),
    ).toBe(true);
  });

  it("keeps a sign-in's new tokens and session when its pair was stored while the rejected call was in flight", async () => {
    const built = build();
    const { access, logger } = built;
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);
    const alice = signIn(database.db, userWithToken("alice", ALICE).id);
    let newCookie = "";
    fake.server.use(
      http.get(`${FAKE_API_URL}/user/installations`, () => {
        database.db
          .update(schema.userTokens)
          .set({
            accessTokenEnc: encrypt("ghu_alice_new", APP_SECRET),
            refreshTokenEnc: encrypt("refresh_new", APP_SECRET),
          })
          .where(eq(schema.userTokens.userId, alice.userId))
          .run();
        newCookie = signIn(database.db, alice.userId).cookie;
        return HttpResponse.json(
          { message: "Bad credentials" },
          { status: 401 },
        );
      }),
    );

    jobs.start();
    jobs.enqueue(ACCESS_JOB, undefined);
    await jobs.stop();

    const [row] = tokensOf(alice.userId);
    expect(
      row === undefined ? null : decrypt(row.accessTokenEnc, APP_SECRET),
    ).toBe("ghu_alice_new");
    expect(sessionsOf(alice.userId)).toHaveLength(2);
    expect(
      (
        await appFor(built).request("/api/me", {
          headers: { Cookie: newCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      logs.some((entry) => entry.msg === "computing user access failed"),
    ).toBe(false);
  });

  it("does not delete a user's tokens when the computation is not asked to revoke", async () => {
    const { access } = build();
    const alice = signIn(database.db, userWithToken("alice", "ghu_unknown").id);

    await expect(access.compute(alice.userId)).rejects.toMatchObject({
      status: 401,
    });

    expect(tokensOf(alice.userId)).toHaveLength(1);
    expect(sessionsOf(alice.userId)).toHaveLength(1);
  });

  it("reports a revoked user from compute", async () => {
    const { access } = build();
    const alice = signIn(database.db, userWithToken("alice", "ghu_unknown").id);
    expect(await access.compute(alice.userId, { revokeRejected: true })).toBe(
      "revoked",
    );
    expect(tokensOf(alice.userId)).toEqual([]);
  });

  it("is scheduled every 60 minutes", async () => {
    vi.useFakeTimers();
    const { access, logger } = build();
    const jobs = createJobs({ logger });
    registerAccessJob(jobs, access, database.db, logger);
    const alice = signIn(database.db, userWithToken("alice", ALICE).id);
    worlds[ALICE] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repo(10, "alice", "notes")] },
    };
    jobs.start();

    await vi.advanceTimersByTimeAsync(ACCESS_INTERVAL_MS - 1);
    expect(accessOf(alice.userId)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // The run waits on real I/O (msw); let it settle on real time.
    vi.useRealTimers();
    await jobs.stop();
    expect(ACCESS_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(accessOf(alice.userId)).toEqual(["R_10"]);
  });
});
