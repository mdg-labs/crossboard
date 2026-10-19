import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { GithubAppCredentials } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import {
  createGithubClient,
  createInstallationClient,
} from "../src/github/index.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import { NO_ETAG } from "../src/sync/discovery.js";
import {
  createReconcile,
  enqueueReconcile,
  RECONCILE_JOB,
  registerReconcileJobs,
} from "../src/sync/reconcile.js";
import { createRefetch } from "../src/sync/refetch.js";
import { createSync } from "../src/sync/sync.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
} from "./github-fake.js";
import { createFakeSyncGithub, type FakeRepo } from "./sync-fake.js";

const fake = createFakeGithub();
const github = createFakeSyncGithub();
const credentials: GithubAppCredentials = {
  appId: APP_ID,
  appSlug: "crossboard",
  clientId: "Iv1.fake",
  clientSecret: "fake-client-secret-value",
  privateKey: APP_PRIVATE_KEY,
  webhookSecret: "fake-webhook-secret-value",
};

const T0 = Date.parse("2026-03-01T00:00:00Z");
const SINCE = "2026-03-01T00:00:00.000Z";
const day = (n: number) => `2026-03-${String(n).padStart(2, "0")}T00:00:00Z`;

let database: TestDatabase;
let active: Set<number>;
let clock: number;

beforeAll(() => fake.listen());
afterAll(() => fake.close());

beforeEach(() => {
  database = createTestDatabase();
  active = new Set();
  clock = T0;
  fake.server.use(...github.handlers);
});

afterEach(() => {
  fake.reset();
  github.reset();
  database.cleanup();
});

function build() {
  const logger = createLogger("silent");
  const client = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    sleep: () => Promise.resolve(),
    logger,
  });
  const installations = createInstallationClient({
    github: client,
    credentials: () => credentials,
  });
  const isActive = (id: number) => active.has(id);
  const issues = createRefetch({
    db: database.db,
    installations,
    isActive,
    logger,
    now: () => clock,
  });
  const sync = createSync({
    db: database.db,
    installations,
    isActive,
    refetch: (ids) => issues.refetch(ids),
    logger,
    now: () => clock,
  });
  const reconcile = createReconcile({
    db: database.db,
    installations,
    isActive,
    issues,
    logger,
    now: () => clock,
  });
  return { sync, reconcile, isActive };
}

function addInstallation(id: number, suspended = false) {
  database.db
    .insert(schema.installations)
    .values({
      id,
      accountLogin: `acct-${String(id)}`,
      accountId: id,
      accountType: "Organization",
      suspended,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  active.add(id);
}

function addRepo(repo: FakeRepo, installationId = 1, syncState = "pending") {
  const [owner = "", name = ""] = repo.name.split("/");
  database.db
    .insert(schema.repos)
    .values({
      id: repo.id,
      databaseId: Number(repo.id.replace(/\D/g, "")),
      installationId,
      owner,
      name,
      private: false,
      syncState: syncState as "pending" | "ready",
      openIssueCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  repo.installationId = installationId;
  github.world.repos.push(repo);
}

const repoRow = (id: string) =>
  database.db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
const issueRows = () =>
  database.db.select().from(schema.issues).orderBy(schema.issues.number).all();
const refState = (id: string) =>
  database.db
    .select()
    .from(schema.issueRefs)
    .where(eq(schema.issueRefs.id, id))
    .get()?.state;

const issue = (
  number: number,
  extra: Partial<FakeRepo["issues"][number]> = {},
) => ({
  id: `I_${String(number)}`,
  repo: "acme/web",
  number,
  ...extra,
});

/** A repo synced at T0 with issues 1 to 3, as the daily sync leaves it. */
async function syncedWeb(): Promise<{
  web: FakeRepo;
  reconcile: ReturnType<typeof build>["reconcile"];
}> {
  addInstallation(1);
  const web: FakeRepo = {
    name: "acme/web",
    id: "R_web",
    issues: [
      issue(1),
      issue(2),
      issue(3, {
        blockedBy: [
          { id: "I_2", repo: "acme/web", number: 2, state: "CLOSED" },
        ],
      }),
    ],
  };
  addRepo(web);
  const { sync, reconcile } = build();
  expect(await sync.syncRepo("R_web")).toBe("synced");
  expect(repoRow("R_web")?.reconcileSince).toBe(SINCE);
  github.world.requests = [];
  github.world.restRequests = [];
  return { web, reconcile };
}

describe("repository reconciliation", () => {
  it("applies a changed, a closed, a new and a pull request item, then ends on a 304 while nothing changes", async () => {
    const { web, reconcile } = await syncedWeb();
    web.issues[0] = issue(1, { title: "Renamed", updatedAt: day(2) });
    web.issues[1] = issue(2, { state: "CLOSED", updatedAt: day(3) });
    web.pulls = [{ id: "PR_9", number: 9, updatedAt: day(4) }];
    web.issues.push(issue(4, { updatedAt: day(5) }));
    clock = T0 + 1000;

    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");

    expect(github.world.restRequests).toHaveLength(1);
    expect(github.world.restRequests[0]).toMatchObject({
      repo: "acme/web",
      ifNoneMatch: NO_ETAG,
      installation: 1,
      params: {
        state: "all",
        since: SINCE,
        sort: "updated",
        direction: "asc",
        per_page: "100",
      },
    });
    expect(issueRows().map((row) => [row.id, row.title])).toEqual([
      ["I_1", "Renamed"],
      ["I_3", "Issue 3"],
      ["I_4", "Issue 4"],
    ]);
    expect(refState("I_2")).toBe("CLOSED");
    const fetched = github
      .requestsFor("IssuesByIds")
      .flatMap((request) => request.variables.ids as string[]);
    expect(fetched.sort()).toEqual(["I_1", "I_4"]);
    expect(refState("PR_9")).toBeUndefined();
    expect(repoRow("R_web")).toMatchObject({
      reconcileSince: day(5),
      restEtag: null,
      lastReconciledAt: clock,
    });

    // The newest issue is listed again, since `since` is inclusive; once the
    // listing stops moving its first page's ETag is kept.
    github.world.requests = [];
    clock += 1000;
    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");
    expect(
      github.requestsFor("IssuesByIds").flatMap((r) => r.variables.ids),
    ).toEqual(["I_4"]);
    const stored = repoRow("R_web");
    expect(stored?.reconcileSince).toBe(day(5));
    expect(stored?.restEtag).toMatch(/^"[0-9a-f]+"$/);

    github.world.requests = [];
    clock += 1000;
    expect(await reconcile.reconcileRepo("R_web")).toBe("unchanged");
    expect(github.world.restRequests.at(-1)?.ifNoneMatch).toBe(
      stored?.restEtag,
    );
    expect(github.world.requests).toEqual([]);
    expect(repoRow("R_web")).toMatchObject({
      reconcileSince: day(5),
      restEtag: stored?.restEtag,
      lastReconciledAt: clock,
    });

    // A change moves the listing: the stored ETag no longer matches.
    web.issues[3] = issue(4, { title: "Edited", updatedAt: day(6) });
    clock += 1000;
    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");
    expect(issueRows().at(-1)?.title).toBe("Edited");
    expect(repoRow("R_web")).toMatchObject({
      reconcileSince: day(6),
      restEtag: null,
    });
  });

  it("follows the pages, sending the ETag with the first only", async () => {
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db
      .update(schema.repos)
      .set({ reconcileSince: SINCE, restEtag: '"old"' })
      .run();
    web.issues = Array.from({ length: 101 }, (_, index) =>
      issue(index + 1, {
        updatedAt: new Date(T0 + (index + 1) * 60_000).toISOString(),
      }),
    );
    const { reconcile } = build();

    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");

    expect(
      github.world.restRequests.map((r) => [
        r.params.since,
        r.params.page,
        r.ifNoneMatch,
      ]),
    ).toEqual([
      [SINCE, undefined, '"old"'],
      [new Date(T0 + 100 * 60_000).toISOString(), undefined, null],
    ]);
    expect(issueRows()).toHaveLength(101);
    expect(repoRow("R_web")?.reconcileSince).toBe(
      new Date(T0 + 101 * 60_000).toISOString(),
    );
  });

  it("applies an issue displaced by an update between two page reads", async () => {
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db.update(schema.repos).set({ reconcileSince: SINCE }).run();
    web.issues = Array.from({ length: 150 }, (_, index) =>
      issue(index + 1, {
        updatedAt: new Date(T0 + (index + 1) * 60_000).toISOString(),
      }),
    );
    const moved = new Date(T0 + 200 * 60_000).toISOString();
    github.world.restFailWith = () => {
      if (github.world.restRequests.length === 2) {
        web.issues[4] = issue(5, { title: "Moved", updatedAt: moved });
      }
      return undefined;
    };
    const { reconcile } = build();

    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");

    expect(issueRows()).toHaveLength(150);
    expect(issueRows()[100]?.title).toBe("Issue 101");
    expect(issueRows()[4]?.title).toBe("Moved");
    expect(repoRow("R_web")?.reconcileSince).toBe(moved);
  });

  it("pages by offset within one since when a full page shares its timestamp", async () => {
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db.update(schema.repos).set({ reconcileSince: SINCE }).run();
    const shared = new Date(T0 + 60_000).toISOString();
    web.issues = Array.from({ length: 230 }, (_, index) =>
      issue(index + 1, { updatedAt: shared }),
    );
    const { reconcile } = build();

    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");

    expect(issueRows()).toHaveLength(230);
    expect(
      github.world.restRequests.map((r) => [r.params.since, r.params.page]),
    ).toEqual([
      [SINCE, undefined],
      [shared, undefined],
      [shared, "2"],
      [shared, "3"],
    ]);
    expect(repoRow("R_web")?.reconcileSince).toBe(shared);
  });

  it("repeats the round, advancing nothing, when an issue is listed twice within one since", async () => {
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db.update(schema.repos).set({ reconcileSince: SINCE }).run();
    const shared = new Date(T0 + 60_000).toISOString();
    web.issues = Array.from({ length: 150 }, (_, index) =>
      issue(index + 1, { updatedAt: shared }),
    );
    github.world.restFailWith = (request) => {
      if (request.params.page === "2") {
        web.issues[5] = issue(6, {
          updatedAt: new Date(T0 + 120_000).toISOString(),
        });
      }
      return undefined;
    };
    const { reconcile } = build();

    expect(await reconcile.reconcileRepo("R_web")).toBe("error");

    expect(issueRows()).toEqual([]);
    expect(repoRow("R_web")?.reconcileSince).toBe(SINCE);
  });

  it("ends a round that keeps returning full pages as an error, advancing nothing", async () => {
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db.update(schema.repos).set({ reconcileSince: SINCE }).run();
    web.issues = Array.from({ length: 10_100 }, (_, index) =>
      issue(index + 1, {
        updatedAt: new Date(T0 + (index + 1) * 1000).toISOString(),
      }),
    );
    const { reconcile } = build();

    expect(await reconcile.reconcileRepo("R_web")).toBe("error");

    expect(github.world.restRequests).toHaveLength(100);
    expect(issueRows()).toEqual([]);
    expect(repoRow("R_web")?.reconcileSince).toBe(SINCE);
  });

  it("changes nothing when a page fails, so the round is repeated whole", async () => {
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db
      .update(schema.repos)
      .set({ reconcileSince: SINCE, restEtag: '"old"' })
      .run();
    web.issues = Array.from({ length: 101 }, (_, index) =>
      issue(index + 1, {
        updatedAt: new Date(T0 + (index + 1) * 1000).toISOString(),
      }),
    );
    github.world.restFailWith = (request) =>
      request.params.since !== SINCE ? 422 : undefined;
    const { reconcile } = build();

    expect(await reconcile.reconcileRepo("R_web")).toBe("error");

    expect(issueRows()).toEqual([]);
    expect(repoRow("R_web")).toMatchObject({
      reconcileSince: SINCE,
      restEtag: '"old"',
      lastReconciledAt: null,
    });

    github.world.restFailWith = undefined;
    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");
    expect(issueRows()).toHaveLength(101);
  });

  it("does not advance past issues it failed to apply", async () => {
    const { web, reconcile } = await syncedWeb();
    web.issues[0] = issue(1, { title: "Renamed", updatedAt: day(2) });
    github.world.failWith = (request) =>
      request.name === "IssuesByIds" ? 422 : undefined;

    expect(await reconcile.reconcileRepo("R_web")).toBe("error");

    expect(issueRows()[0]?.title).toBe("Issue 1");
    expect(repoRow("R_web")).toMatchObject({
      reconcileSince: SINCE,
      restEtag: null,
      lastReconciledAt: null,
    });

    github.world.failWith = undefined;
    expect(await reconcile.reconcileRepo("R_web")).toBe("reconciled");
    expect(issueRows()[0]?.title).toBe("Renamed");
  });

  it("discards the round when a sync moved reconcile_since meanwhile", async () => {
    const { web, reconcile } = await syncedWeb();
    web.issues[0] = issue(1, { title: "Renamed", updatedAt: day(2) });
    github.world.restFailWith = () => {
      database.db
        .update(schema.repos)
        .set({ reconcileSince: day(9) })
        .run();
      return undefined;
    };

    expect(await reconcile.reconcileRepo("R_web")).toBe("skipped");

    expect(repoRow("R_web")).toMatchObject({
      reconcileSince: day(9),
      restEtag: null,
      lastReconciledAt: null,
    });
  });

  it("clears the ETag when a full sync moves reconcile_since", async () => {
    const { sync } = build();
    addInstallation(1);
    const web: FakeRepo = { name: "acme/web", id: "R_web", issues: [] };
    addRepo(web, 1, "ready");
    database.db.update(schema.repos).set({ restEtag: '"old"' }).run();

    expect(await sync.syncRepo("R_web")).toBe("synced");

    expect(repoRow("R_web")?.restEtag).toBeNull();
  });

  it("leaves a repository that is not ready, or whose installation is suspended or inactive, alone", async () => {
    addInstallation(1);
    addInstallation(2, true);
    addInstallation(3);
    active.delete(3);
    const states = [
      ["R_1", 1, "pending"],
      ["R_2", 2, "ready"],
      ["R_3", 3, "ready"],
      ["R_4", 1, "ready"],
    ] as const;
    for (const [id, installationId, state] of states) {
      addRepo(
        { name: `acme/${id.toLowerCase()}`, id, issues: [] },
        installationId,
        state,
      );
      database.db
        .update(schema.repos)
        .set({ reconcileSince: SINCE })
        .where(eq(schema.repos.id, id))
        .run();
    }
    database.db
      .update(schema.installations)
      .set({ suspended: true })
      .where(eq(schema.installations.id, 2))
      .run();
    const { reconcile } = build();

    expect(
      await Promise.all(states.map(([id]) => reconcile.reconcileRepo(id))),
    ).toEqual(["skipped", "skipped", "skipped", "reconciled"]);
    expect(github.world.restRequests.map((r) => r.repo)).toEqual(["acme/r_4"]);
  });
});

describe("the reconciliation schedule", () => {
  it("queues a job per ready repository of an active installation, and one per repository at a time", async () => {
    addInstallation(1);
    addInstallation(2, true);
    for (const [id, installationId, state] of [
      ["R_1", 1, "ready"],
      ["R_2", 1, "pending"],
      ["R_3", 2, "ready"],
    ] as const) {
      addRepo(
        { name: `acme/${id.toLowerCase()}`, id, issues: [] },
        installationId,
        state,
      );
      database.db
        .update(schema.repos)
        .set({ reconcileSince: SINCE })
        .where(eq(schema.repos.id, id))
        .run();
    }
    database.db
      .update(schema.installations)
      .set({ suspended: true })
      .where(eq(schema.installations.id, 2))
      .run();
    const { reconcile, isActive } = build();
    const jobs = createJobs({ logger: createLogger("silent") });
    registerReconcileJobs(jobs, reconcile, database.db, isActive, 60_000);
    expect(() => {
      jobs.schedule(RECONCILE_JOB, 1000);
    }).toThrow(/already scheduled/);

    // Queued before the queue starts, so the first is still pending.
    expect(enqueueReconcile(jobs, { id: "R_9", installationId: 1 })).toBe(true);
    expect(enqueueReconcile(jobs, { id: "R_9", installationId: 1 })).toBe(
      false,
    );
    jobs.start();
    try {
      expect(jobs.enqueue(RECONCILE_JOB, undefined)).toBe(true);
      const deadline = Date.now() + 5000;
      while (github.world.restRequests.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await jobs.stop();
    }
    expect(github.world.restRequests.map((r) => r.repo)).toEqual(["acme/r_1"]);
  });

  it("runs on the interval it is given", async () => {
    addInstallation(1);
    addRepo({ name: "acme/web", id: "R_web", issues: [] }, 1, "ready");
    database.db.update(schema.repos).set({ reconcileSince: SINCE }).run();
    const { reconcile, isActive } = build();
    const jobs = createJobs({ logger: createLogger("silent") });
    registerReconcileJobs(jobs, reconcile, database.db, isActive, 30);
    jobs.start();
    try {
      const deadline = Date.now() + 5000;
      while (github.world.restRequests.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await jobs.stop();
    }
    expect(github.world.restRequests.length).toBeGreaterThanOrEqual(2);
  });
});
