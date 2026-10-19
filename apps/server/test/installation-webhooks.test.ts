import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  activeInstallationIds,
  createAccess,
  type Access,
} from "../src/access/index.js";
import { issueListSchema } from "../src/api/schemas.js";
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { createUserTokens } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createJobs, type Jobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import { DISCOVERY_JOB, enqueueDiscovery } from "../src/sync/discovery.js";
import { RECONCILE_REPO_JOB } from "../src/sync/reconcile.js";
import {
  createWebhookHandlers,
  type WebhookHandler,
} from "../src/webhooks/index.js";
import {
  accessHandlers,
  storeTokens,
  type World,
  type WorldRepo,
} from "./access.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { createFakeGithub, FAKE_API_URL, FAKE_WEB_URL } from "./github-fake.js";
import { githubEnv, unusedInstallations, validEnv } from "./helpers.js";
import { addUser, signIn } from "./sign-in.js";

const SECRET = githubEnv.GITHUB_WEBHOOK_SECRET;
const ALICE_INSTALLATION = 7;
const BOB_INSTALLATION = 8;
const CAROL_INSTALLATION = 9;
const ALICE = "ghu_alice";
const BOB = "ghu_bob";
const WEB = "R_web";
const API = "R_api";
const TOOLS = "R_tools";
const CAROL_REPO = "R_carol";

const fake = createFakeGithub();
beforeAll(() => fake.listen());
afterAll(() => fake.close());

let dir: string;
let database: TestDatabase;
let jobs: Jobs;
let worlds: Record<string, World>;
let discovered: number[];
let reconciled: string[];
let computed: number[];
let handled: number;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-installation-webhooks-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
  worlds = {};
  discovered = [];
  reconciled = [];
  computed = [];
  handled = 0;
  fake.server.use(...accessHandlers(worlds));
});

afterEach(async () => {
  await jobs.stop();
  fake.reset();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const repoRow = (
  id: string,
  databaseId: number,
  installationId: number,
  owner: string,
  name: string,
  syncState: "ready" | "pending" | "syncing" | "skipped" = "ready",
) => ({
  id,
  databaseId,
  installationId,
  owner,
  name,
  private: true,
  syncState,
  openIssueCount: 1,
  createdAt: 1,
  updatedAt: 1,
});

const worldRepo = (
  databaseId: number,
  nodeId: string,
  owner: string,
  name: string,
): WorldRepo => ({ id: databaseId, nodeId, owner, name });

function seedIssue(repoId: string, number: number) {
  database.db
    .insert(schema.issues)
    .values({
      id: `I_${repoId}_${String(number)}`,
      databaseId: number + repoId.length * 1000,
      repoId,
      number,
      title: `${repoId} #${String(number)}`,
      url: "https://github.com/x/y/issues/1",
      authorLogin: "alice",
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

interface Seeded {
  alice: ReturnType<typeof signIn>;
  bob: ReturnType<typeof signIn>;
}

/**
 * Installations A (alice) and B (bob) are active by their accounts; C is not
 * allowed. Alice reaches R_web and R_api through A, bob R_tools through B.
 */
function seed(): Seeded {
  for (const [id, login] of [
    [ALICE_INSTALLATION, "alice"],
    [BOB_INSTALLATION, "bob"],
    [CAROL_INSTALLATION, "carol"],
  ] as const) {
    database.db
      .insert(schema.installations)
      .values({
        id,
        accountLogin: login,
        accountId: 1000 + id,
        accountType: "User",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }
  database.db
    .insert(schema.repos)
    .values([
      repoRow(WEB, 1, ALICE_INSTALLATION, "alice", "web"),
      repoRow(API, 2, ALICE_INSTALLATION, "alice", "api"),
      repoRow(TOOLS, 3, BOB_INSTALLATION, "bob", "tools"),
      repoRow(CAROL_REPO, 4, CAROL_INSTALLATION, "carol", "site"),
    ])
    .run();
  for (const repoId of [WEB, API, TOOLS, CAROL_REPO]) {
    seedIssue(repoId, 1);
    seedIssue(repoId, 2);
  }
  database.db
    .insert(schema.issueRefs)
    .values({
      id: "I_ref",
      repoFullName: "x/y",
      number: 1,
      title: "ref",
      state: "OPEN",
      url: "https://github.com/x/y/issues/1",
      seenAt: 1,
    })
    .run();
  database.db
    .insert(schema.issueDeps)
    .values([
      { blockedId: `I_${WEB}_1`, blockingId: "I_ref" },
      { blockedId: `I_${TOOLS}_1`, blockingId: "I_ref" },
    ])
    .run();

  const alice = signIn(database.db, addUser(database.db, "alice").id);
  const bob = signIn(database.db, addUser(database.db, "bob").id);
  for (const [user, token] of [
    [alice, ALICE],
    [bob, BOB],
  ] as const) {
    storeTokens(database.db, validEnv.CROSSBOARD_APP_SECRET, user.userId, {
      access: token,
    });
  }
  worlds[ALICE] = {
    installations: [{ id: ALICE_INSTALLATION, login: "alice" }],
    repos: {
      [ALICE_INSTALLATION]: [
        worldRepo(1, WEB, "alice", "web"),
        worldRepo(2, API, "alice", "api"),
      ],
    },
  };
  worlds[BOB] = {
    installations: [{ id: BOB_INSTALLATION, login: "bob" }],
    repos: { [BOB_INSTALLATION]: [worldRepo(3, TOOLS, "bob", "tools")] },
  };
  for (const [user, repoIds] of [
    [alice, [WEB, API]],
    [bob, [TOOLS]],
  ] as const) {
    database.db
      .insert(schema.userInstallations)
      .values({
        userId: user.userId,
        installationId: user === alice ? ALICE_INSTALLATION : BOB_INSTALLATION,
        computedAt: 1,
      })
      .run();
    database.db
      .insert(schema.userRepoAccess)
      .values(
        repoIds.map((repoId) => ({
          userId: user.userId,
          repoId,
          computedAt: 1,
        })),
      )
      .run();
    database.db
      .insert(schema.boards)
      .values({
        userId: user.userId,
        name: "Board",
        baseFilter: "is:open",
        sort: "updated-desc",
        subIssueMode: "flat",
        showOther: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.savedViews)
      .values({
        userId: user.userId,
        name: "View",
        filter: "is:open",
        sort: "updated-desc",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }
  return { alice, bob };
}

function build(env: Record<string, string> = {}) {
  const logger = createLogger("silent");
  const config = loadConfig({
    ...validEnv,
    ...githubEnv,
    CROSSBOARD_ALLOWED_USERS: "alice,bob",
    ...env,
  });
  const setup = createSetup({ db: database.db, config, logger });
  const github = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    sleep: () => Promise.resolve(),
    logger,
  });
  jobs = createJobs({ logger });
  jobs.register<{ installationId: number }>(
    DISCOVERY_JOB,
    ({ installationId }) => {
      discovered.push(installationId);
    },
  );
  jobs.register<{ repoId: string }>(RECONCILE_REPO_JOB, ({ repoId }) => {
    reconciled.push(repoId);
  });
  const real = createAccess({
    db: database.db,
    github,
    allowlist: setup.allowlist,
    logger,
    tokens: createUserTokens({
      db: database.db,
      github,
      credentials: () => setup.credentials(),
      appSecret: config.appSecret,
      logger,
    }),
    onActivated: (ids) => {
      for (const id of ids) enqueueDiscovery(jobs, id);
    },
  });
  const access: Access = {
    async compute(userId, options) {
      computed.push(userId);
      return real.compute(userId, options);
    },
  };
  jobs.start();
  const built = createWebhookHandlers({
    db: database.db,
    jobs,
    issues: {
      refetch: () => Promise.resolve(0),
      remove: () => Promise.resolve(0),
    },
    access,
    allowlist: setup.allowlist,
  });
  const handlers: Record<string, WebhookHandler> = {};
  for (const [event, handler] of Object.entries(built)) {
    handlers[event] = async (delivery) => {
      try {
        await handler(delivery);
      } finally {
        handled++;
      }
    };
  }
  return createApp({
    logger,
    db: database.db,
    github,
    installations: unusedInstallations,
    jobs,
    webhookHandlers: handlers,
    version: "1.0.0",
    webRoot: join(dir, "dist"),
    setup,
    access,
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
  });
}

type App = ReturnType<typeof build>;

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function post(
  app: App,
  event: string,
  payload: object,
  secret = SECRET,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": `delivery-${String(Math.random())}`,
      "X-Hub-Signature-256": sign(body, secret),
    },
  });
}

/** Delivers an event the app applies, and waits until its handler has finished. */
async function deliver(app: App, event: string, payload: object) {
  const before = handled;
  const response = await post(app, event, payload);
  expect(response.status).toBe(202);
  await vi.waitFor(() => {
    expect(handled).toBe(before + 1);
  });
}

/** Delivers an event the intake drops, and lets the queue run. */
async function deliverDropped(app: App, event: string, payload: object) {
  const response = await post(app, event, payload);
  expect(response.status).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(handled).toBe(0);
}

const installationPayload = (
  action: string,
  id: number,
  extra: object = {},
) => ({
  action,
  installation: {
    id,
    account: { id: 1000 + id, login: "alice" },
    target_type: "User",
    suspended_at: null,
    ...extra,
  },
});

const repositoryPayload = (
  action: string,
  installation: number,
  nodeId: string,
  owner: string,
  name: string,
) => ({
  action,
  installation: { id: installation },
  repository: { node_id: nodeId, name, owner: { login: owner }, private: true },
});

const reposOf = () =>
  database.db.select().from(schema.repos).orderBy(schema.repos.id).all();
const repoIds = () => reposOf().map((row) => row.id);
const repo = (id: string) => reposOf().find((row) => row.id === id);
const installationRow = (id: number) =>
  database.db
    .select()
    .from(schema.installations)
    .where(eq(schema.installations.id, id))
    .get();
const accessOf = (userId: number) =>
  database.db
    .select()
    .from(schema.userRepoAccess)
    .where(eq(schema.userRepoAccess.userId, userId))
    .all()
    .map((row) => row.repoId)
    .sort();
const counts = () => ({
  boards: database.db.select().from(schema.boards).all().length,
  views: database.db.select().from(schema.savedViews).all().length,
});

async function visibleRepos(app: App, cookie: string): Promise<string[]> {
  const response = await app.request("/api/issues", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  const body = issueListSchema.parse(await response.json());
  return [
    ...new Set(
      body.items.map((item) => `${item.repo.owner}/${item.repo.name}`),
    ),
  ].sort();
}

describe("installation", () => {
  it("records a created installation of an allowed account and starts its discovery", async () => {
    seed();
    const app = build();
    await deliver(
      app,
      "installation",
      installationPayload("created", 20, {
        account: { id: 2020, login: "bob" },
        target_type: "Organization",
      }),
    );
    expect(installationRow(20)).toMatchObject({
      accountLogin: "bob",
      accountId: 2020,
      accountType: "Organization",
      suspended: false,
    });
    expect(
      activeInstallationIds(database.db, {
        users: ["alice", "bob"],
        orgs: [],
      }).has(20),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(discovered).toEqual([20]);
    });
  });

  it("records an installation of an account that is not allowed without discovering it", async () => {
    seed();
    const app = build();
    await deliver(
      app,
      "installation",
      installationPayload("created", 21, {
        account: { id: 2021, login: "mallory" },
      }),
    );
    expect(installationRow(21)?.accountLogin).toBe("mallory");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discovered).toEqual([]);
  });

  it("purges the repos of an installation whose recorded account is no longer allowed", async () => {
    seed();
    database.db.delete(schema.userInstallations).run();
    worlds[ALICE] = { installations: [], repos: {} };
    const app = build();
    await deliver(
      app,
      "installation",
      installationPayload("created", ALICE_INSTALLATION, {
        account: { id: 1007, login: "mallory" },
      }),
    );
    expect(installationRow(ALICE_INSTALLATION)?.accountLogin).toBe("mallory");
    expect(repoIds()).toEqual([CAROL_REPO, TOOLS].sort());
    expect(counts()).toEqual({ boards: 2, views: 2 });
  });

  it("activates a created installation that a user with a live session reaches", async () => {
    seed();
    const app = build();
    const world = worlds[ALICE];
    if (world === undefined) throw new Error("fixture");
    world.installations.push({
      id: 22,
      login: "some-org",
      type: "Organization",
    });
    world.repos[22] = [worldRepo(9, "R_org", "some-org", "app")];
    await deliver(
      app,
      "installation",
      installationPayload("created", 22, {
        account: { id: 2022, login: "some-org" },
        target_type: "Organization",
      }),
    );
    await vi.waitFor(() => {
      expect(discovered).toContain(22);
    });
    expect(repo("R_org")?.installationId).toBe(22);
  });

  it("purges a deleted installation and its repos but no board or saved view", async () => {
    const { alice } = seed();
    const app = build();
    worlds[ALICE] = { installations: [], repos: {} };
    await deliver(
      app,
      "installation",
      installationPayload("deleted", ALICE_INSTALLATION),
    );
    expect(repoIds()).toEqual([TOOLS, CAROL_REPO].sort());
    expect(installationRow(ALICE_INSTALLATION)).toBeUndefined();
    expect(installationRow(BOB_INSTALLATION)).toBeDefined();
    const issueRepos = new Set(
      database.db
        .select()
        .from(schema.issues)
        .all()
        .map((row) => row.repoId),
    );
    expect(issueRepos).toEqual(new Set([TOOLS, CAROL_REPO]));
    expect(database.db.select().from(schema.issueDeps).all()).toEqual([
      { blockedId: `I_${TOOLS}_1`, blockingId: "I_ref" },
    ]);
    expect(counts()).toEqual({ boards: 2, views: 2 });
    expect(accessOf(alice.userId)).toEqual([]);
  });

  it("purges the installations a deleted one leaves inactive, so a user who was allowed only through it no longer sees their repos", async () => {
    const { alice, bob } = seed();
    database.db
      .insert(schema.installations)
      .values({
        id: 20,
        accountLogin: "acme",
        accountId: 2020,
        accountType: "Organization",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    database.db
      .insert(schema.userInstallations)
      .values({ userId: bob.userId, installationId: 20, computedAt: 1 })
      .run();
    const allowlist = { users: ["alice"], orgs: ["acme"] };
    expect(
      [...activeInstallationIds(database.db, allowlist)].sort((a, b) => a - b),
    ).toEqual([ALICE_INSTALLATION, BOB_INSTALLATION, 20]);
    const app = build({
      CROSSBOARD_ALLOWED_USERS: "alice",
      CROSSBOARD_ALLOWED_ORGS: "acme",
    });
    expect(await visibleRepos(app, bob.cookie)).toEqual(["bob/tools"]);

    await deliver(app, "installation", installationPayload("deleted", 20));

    expect([...activeInstallationIds(database.db, allowlist)]).toEqual([
      ALICE_INSTALLATION,
    ]);
    expect(
      new Set(
        database.db
          .select()
          .from(schema.issues)
          .all()
          .map((row) => row.repoId),
      ),
    ).toEqual(new Set([WEB, API, CAROL_REPO]));
    expect(database.db.select().from(schema.issueDeps).all()).toEqual([
      { blockedId: `I_${WEB}_1`, blockingId: "I_ref" },
    ]);
    expect(installationRow(20)).toBeUndefined();
    expect(installationRow(BOB_INSTALLATION)).toBeDefined();
    expect(await visibleRepos(app, bob.cookie)).toEqual([]);
    expect(await visibleRepos(app, alice.cookie)).toEqual([
      "alice/api",
      "alice/web",
    ]);
    expect(counts()).toEqual({ boards: 2, views: 2 });
  });

  it("flags a suspended installation and clears the flag on unsuspend, then discovers and reconciles it", async () => {
    seed();
    database.db
      .update(schema.repos)
      .set({ syncState: "pending" })
      .where(eq(schema.repos.id, API))
      .run();
    const app = build();
    const [listed] = worlds[ALICE]?.installations ?? [];
    if (listed === undefined) throw new Error("fixture");
    listed.suspended = true;
    await deliver(
      app,
      "installation",
      installationPayload("suspend", ALICE_INSTALLATION),
    );
    expect(installationRow(ALICE_INSTALLATION)?.suspended).toBe(true);
    expect(installationRow(BOB_INSTALLATION)?.suspended).toBe(false);
    expect(discovered).toEqual([]);

    listed.suspended = false;
    await deliver(
      app,
      "installation",
      installationPayload("unsuspend", ALICE_INSTALLATION),
    );
    expect(installationRow(ALICE_INSTALLATION)?.suspended).toBe(false);
    await vi.waitFor(() => {
      expect(discovered).toEqual([ALICE_INSTALLATION]);
      expect(reconciled).toEqual([WEB]);
    });
  });

  it("recomputes access for users with a live session only, after an installation event", async () => {
    const { alice, bob } = seed();
    database.db
      .update(schema.sessions)
      .set({ expiresAt: 1 })
      .where(eq(schema.sessions.userId, bob.userId))
      .run();
    const app = build();
    await deliver(
      app,
      "installation",
      installationPayload("suspend", ALICE_INSTALLATION),
    );
    expect(computed).toEqual([alice.userId]);
  });

  it("takes the suspended installation's repos out of the user's view until it is unsuspended", async () => {
    const { alice } = seed();
    const app = build();
    expect(await visibleRepos(app, alice.cookie)).toEqual([
      "alice/api",
      "alice/web",
    ]);
    const world = worlds[ALICE];
    if (world === undefined) throw new Error("fixture");
    const [installation] = world.installations;
    if (installation === undefined) throw new Error("fixture");
    installation.suspended = true;
    await deliver(
      app,
      "installation",
      installationPayload("suspend", ALICE_INSTALLATION),
    );
    expect(repoIds()).toContain(WEB);
    expect(await visibleRepos(app, alice.cookie)).toEqual([]);
  });

  it("ignores a created payload without an account and an action it does not handle", async () => {
    seed();
    const app = build();
    await deliver(app, "installation", {
      action: "created",
      installation: { id: 30, target_type: "User" },
    });
    expect(installationRow(30)).toBeUndefined();
    await deliver(
      app,
      "installation",
      installationPayload("new_permissions_accepted", ALICE_INSTALLATION),
    );
    expect(computed).toEqual([]);
  });

  it("applies nothing for a delivery with a bad signature", async () => {
    seed();
    const app = build();
    const response = await post(
      app,
      "installation",
      installationPayload("deleted", ALICE_INSTALLATION),
      "not-the-secret",
    );
    expect(response.status).toBe(401);
    expect(repoIds()).toHaveLength(4);
    expect(installationRow(ALICE_INSTALLATION)).toBeDefined();
  });
});

describe("installation_repositories", () => {
  it("discovers the installation on added and recomputes access, which records the new repo for the user", async () => {
    const { alice } = seed();
    const app = build();
    const world = worlds[ALICE];
    if (world === undefined) throw new Error("fixture");
    world.repos[ALICE_INSTALLATION]?.push(
      worldRepo(5, "R_new", "alice", "new"),
    );
    await deliver(app, "installation_repositories", {
      action: "added",
      installation: { id: ALICE_INSTALLATION },
      repositories_added: [{ node_id: "R_new", name: "new" }],
    });
    await vi.waitFor(() => {
      expect(discovered).toEqual([ALICE_INSTALLATION]);
    });
    expect(accessOf(alice.userId)).toEqual([API, "R_new", WEB].sort());
  });

  it("purges removed repos so the user no longer sees their issues", async () => {
    const { alice } = seed();
    const app = build();
    expect(await visibleRepos(app, alice.cookie)).toEqual([
      "alice/api",
      "alice/web",
    ]);
    const world = worlds[ALICE];
    if (world === undefined) throw new Error("fixture");
    world.repos[ALICE_INSTALLATION] = [worldRepo(2, API, "alice", "api")];
    await deliver(app, "installation_repositories", {
      action: "removed",
      installation: { id: ALICE_INSTALLATION },
      repositories_removed: [{ node_id: WEB, name: "web" }],
    });
    expect(repoIds()).toEqual([API, CAROL_REPO, TOOLS].sort());
    expect(database.db.select().from(schema.issueDeps).all()).toEqual([
      { blockedId: `I_${TOOLS}_1`, blockingId: "I_ref" },
    ]);
    expect(await visibleRepos(app, alice.cookie)).toEqual(["alice/api"]);
    expect(counts()).toEqual({ boards: 2, views: 2 });
  });

  it("purges only the repos of the installation that sent the delivery", async () => {
    seed();
    const app = build();
    await deliver(app, "installation_repositories", {
      action: "removed",
      installation: { id: ALICE_INSTALLATION },
      repositories_removed: [
        { node_id: TOOLS, name: "tools" },
        { node_id: CAROL_REPO, name: "site" },
      ],
    });
    expect(repoIds()).toEqual([API, CAROL_REPO, TOOLS, WEB].sort());
    expect(database.db.select().from(schema.issues).all().length).toBe(8);
  });

  it("applies a removal for an installation that is not active yet, but starts no discovery for it", async () => {
    seed();
    const app = build();
    await deliver(app, "installation_repositories", {
      action: "removed",
      installation: { id: CAROL_INSTALLATION },
      repositories_removed: [{ node_id: CAROL_REPO, name: "site" }],
    });
    expect(repo(CAROL_REPO)).toBeUndefined();
    expect(discovered).toEqual([]);
  });
});

describe("repository", () => {
  it.each(["archived", "deleted"])("purges the repo on %s", async (action) => {
    const { alice } = seed();
    const app = build();
    await deliver(
      app,
      "repository",
      repositoryPayload(action, ALICE_INSTALLATION, WEB, "alice", "web"),
    );
    expect(repoIds()).toEqual([API, CAROL_REPO, TOOLS].sort());
    expect(database.db.select().from(schema.issueDeps).all()).toEqual([
      { blockedId: `I_${TOOLS}_1`, blockingId: "I_ref" },
    ]);
    expect(accessOf(alice.userId)).toEqual([API]);
    expect(counts()).toEqual({ boards: 2, views: 2 });
  });

  it.each(["renamed", "transferred"])(
    "updates owner and name on %s, then recomputes access",
    async (action) => {
      const { alice } = seed();
      const app = build();
      const world = worlds[ALICE];
      if (world === undefined) throw new Error("fixture");
      world.repos[ALICE_INSTALLATION] = [
        worldRepo(1, WEB, "newowner", "renamed"),
        worldRepo(2, API, "alice", "api"),
      ];
      await deliver(
        app,
        "repository",
        repositoryPayload(
          action,
          ALICE_INSTALLATION,
          WEB,
          "newowner",
          "renamed",
        ),
      );
      expect(repo(WEB)).toMatchObject({ owner: "newowner", name: "renamed" });
      expect(computed).toContain(alice.userId);
      expect(accessOf(alice.userId)).toEqual([API, WEB].sort());
    },
  );

  it("keeps the stored name when another repo already holds the new one, and still recomputes access", async () => {
    const { alice } = seed();
    const app = build();
    await deliver(
      app,
      "repository",
      repositoryPayload("renamed", ALICE_INSTALLATION, WEB, "alice", "api"),
    );
    expect(repo(WEB)).toMatchObject({ owner: "alice", name: "web" });
    expect(computed).toContain(alice.userId);
  });

  it.each([
    ["privatized", true],
    ["publicized", false],
  ] as const)(
    "sets the private flag on %s and recomputes access",
    async (action, flag) => {
      const { alice } = seed();
      database.db
        .update(schema.repos)
        .set({ private: !flag })
        .where(eq(schema.repos.id, WEB))
        .run();
      const app = build();
      await deliver(
        app,
        "repository",
        repositoryPayload(action, ALICE_INSTALLATION, WEB, "alice", "web"),
      );
      expect(repo(WEB)?.private).toBe(flag);
      expect(computed).toContain(alice.userId);
    },
  );

  it("marks an unarchived repo pending and discovers its installation, leaving a syncing repo alone", async () => {
    seed();
    database.db
      .update(schema.repos)
      .set({ syncState: "skipped", syncDetail: "archived" })
      .where(eq(schema.repos.id, WEB))
      .run();
    database.db
      .update(schema.repos)
      .set({ syncState: "syncing" })
      .where(eq(schema.repos.id, API))
      .run();
    const app = build();
    await deliver(
      app,
      "repository",
      repositoryPayload("unarchived", ALICE_INSTALLATION, WEB, "alice", "web"),
    );
    expect(repo(WEB)).toMatchObject({ syncState: "pending", syncDetail: null });
    await vi.waitFor(() => {
      expect(discovered).toEqual([ALICE_INSTALLATION]);
    });
    await deliver(
      app,
      "repository",
      repositoryPayload("unarchived", ALICE_INSTALLATION, API, "alice", "api"),
    );
    expect(repo(API)?.syncState).toBe("syncing");
  });

  it("changes no repo of another installation, whatever the action", async () => {
    seed();
    const app = build();
    const before = JSON.stringify(reposOf());
    for (const action of [
      "archived",
      "deleted",
      "renamed",
      "transferred",
      "unarchived",
      "privatized",
      "publicized",
    ]) {
      await deliver(
        app,
        "repository",
        repositoryPayload(
          action,
          ALICE_INSTALLATION,
          TOOLS,
          "mallory",
          "taken",
        ),
      );
    }
    expect(JSON.stringify(reposOf())).toBe(before);
    expect(database.db.select().from(schema.issues).all().length).toBe(8);
  });

  it("drops a delivery from an installation that is not active", async () => {
    seed();
    const app = build();
    await deliverDropped(
      app,
      "repository",
      repositoryPayload(
        "deleted",
        CAROL_INSTALLATION,
        CAROL_REPO,
        "carol",
        "site",
      ),
    );
    expect(repo(CAROL_REPO)).toBeDefined();
  });

  it("applies nothing without an installation in the payload", async () => {
    seed();
    const app = build();
    await deliver(app, "repository", {
      action: "deleted",
      repository: { node_id: WEB, name: "web", owner: { login: "alice" } },
    });
    expect(repo(WEB)).toBeDefined();
  });
});

describe("github_app_authorization", () => {
  it("deletes the tokens and sessions of the sender, and only theirs", async () => {
    const { alice, bob } = seed();
    const app = build();
    const sender = database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, alice.userId))
      .get();
    if (sender === undefined) throw new Error("fixture");
    await deliver(app, "github_app_authorization", {
      action: "revoked",
      sender: { id: sender.githubId, login: "alice" },
    });
    const sessionsOf = (userId: number) =>
      database.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, userId))
        .all().length;
    const tokensOf = (userId: number) =>
      database.db
        .select()
        .from(schema.userTokens)
        .where(eq(schema.userTokens.userId, userId))
        .all().length;
    expect(sessionsOf(alice.userId)).toBe(0);
    expect(tokensOf(alice.userId)).toBe(0);
    expect(sessionsOf(bob.userId)).toBe(1);
    expect(tokensOf(bob.userId)).toBe(1);
    expect(repoIds()).toHaveLength(4);
    expect(counts()).toEqual({ boards: 2, views: 2 });
    const response = await app.request("/api/issues", {
      headers: { Cookie: alice.cookie },
    });
    expect(response.status).toBe(401);
  });

  it("acts on every action, and on a sender it does not know", async () => {
    const { bob } = seed();
    const app = build();
    await deliver(app, "github_app_authorization", {
      action: "unexpected",
      sender: { id: 999_999 },
    });
    expect(database.db.select().from(schema.sessions).all()).toHaveLength(2);
    const sender = database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, bob.userId))
      .get();
    if (sender === undefined) throw new Error("fixture");
    await deliver(app, "github_app_authorization", {
      action: "unexpected",
      sender: { id: sender.githubId },
    });
    expect(database.db.select().from(schema.sessions).all()).toHaveLength(1);
    expect(database.db.select().from(schema.userTokens).all()).toHaveLength(1);
  });

  it("deletes nothing for a delivery with a bad signature", async () => {
    const { alice } = seed();
    const app = build();
    const sender = database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, alice.userId))
      .get();
    const response = await post(
      app,
      "github_app_authorization",
      { action: "revoked", sender: { id: sender?.githubId } },
      "not-the-secret",
    );
    expect(response.status).toBe(401);
    expect(database.db.select().from(schema.sessions).all()).toHaveLength(2);
    expect(database.db.select().from(schema.userTokens).all()).toHaveLength(2);
  });
});
