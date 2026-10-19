import { eq } from "drizzle-orm";
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
import { SESSION_TTL_MS, createSession } from "../src/auth/sessions/index.js";
import { createUserTokens } from "../src/auth/tokens.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import {
  accessHandlers,
  storeTokens,
  type World,
  type WorldRepo,
} from "./access.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { createFakeGithub, FAKE_API_URL, FAKE_WEB_URL } from "./github-fake.js";
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
) {
  const logger = createLogger("trace", {
    write: (chunk) => logs.push(JSON.parse(chunk)),
  });
  const github = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
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
    ...(now === undefined ? {} : { now }),
  });
  return { access, tokens, logger };
}

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
    const first = signIn(database.db, userWithToken("alice", "ghu_unknown").id);
    const second = signIn(database.db, userWithToken("bob", BOB).id);
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
