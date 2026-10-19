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
  assertReadOnlyDocument,
  createGithubClient,
  createInstallationClient,
} from "../src/github/index.js";
import { queries } from "../src/github/queries/index.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import {
  createSync,
  enqueueSyncAtStart,
  registerSyncJob,
  SYNC_JOB,
} from "../src/sync/sync.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
} from "./github-fake.js";
import {
  COST,
  createFakeSyncGithub,
  type FakeIssue,
  type FakeRef,
  type FakeRepo,
} from "./sync-fake.js";

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

let database: TestDatabase;
let logs: Record<string, unknown>[];
let active: Set<number>;

beforeAll(() => fake.listen());
afterAll(() => fake.close());

beforeEach(() => {
  database = createTestDatabase();
  logs = [];
  active = new Set();
  fake.server.use(...github.handlers);
});

afterEach(() => {
  fake.reset();
  github.reset();
  database.cleanup();
});

function build(now?: () => number) {
  const logger = createLogger("trace", {
    write: (chunk) => logs.push(JSON.parse(chunk)),
  });
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
  return createSync({
    db: database.db,
    installations,
    isActive: (id) => active.has(id),
    logger,
    ...(now === undefined ? {} : { now }),
  });
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

function addRepo(
  repo: FakeRepo,
  installationId = 1,
  syncState: "pending" | "syncing" | "ready" | "error" | "skipped" = "pending",
) {
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
      syncState,
      openIssueCount: repo.issues.length,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  github.world.repos.push(repo);
}

const repoRow = (id: string) =>
  database.db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
const issueRows = () =>
  database.db.select().from(schema.issues).orderBy(schema.issues.number).all();

const issue = (number: number, extra: Partial<FakeIssue> = {}): FakeIssue => ({
  id: `I_${String(number)}`,
  repo: "acme/web",
  number,
  ...extra,
});

describe("the open issues query", () => {
  it("is registered, read-only and asks for 100 issues with the SPEC §5.3 selection", () => {
    expect(() => {
      assertReadOnlyDocument(queries.openIssuesPage.document);
    }).not.toThrow();
    const document = queries.openIssuesPage.document;
    expect(document).toContain(
      "issues(states: OPEN, first: 100, after: $after)",
    );
    for (const field of [
      "databaseId",
      "issueType { name color }",
      "milestone { title url }",
      "labels(first: 20)",
      "assignees(first: 10)",
      "parent {",
      "subIssuesSummary { total completed }",
      "issueDependenciesSummary { totalBlockedBy totalBlocking }",
      "blockedBy(first: 20)",
      "blocking(first: 20)",
    ]) {
      expect(document).toContain(field);
    }
  });
});

describe("the connection follow-up query", () => {
  it("is registered, read-only and pages each connection of one issue", () => {
    const { document } = queries.issueConnectionsPage;
    expect(() => {
      assertReadOnlyDocument(document);
    }).not.toThrow();
    for (const field of [
      "labels(first: 20, after: $labelsAfter)",
      "assignees(first: 10, after: $assigneesAfter)",
      "blockedBy(first: 20, after: $blockedByAfter)",
      "blocking(first: 20, after: $blockingAfter)",
    ]) {
      expect(document).toContain(field);
    }
  });
});

describe("a repository's initial sync", () => {
  it("pages the open issues and stores their scalars, labels and assignees", async () => {
    addInstallation(1);
    const first = issue(1, {
      title: "First",
      labels: [
        { id: "L_bug", name: "bug", color: "d73a4a", description: "Broken" },
        { id: "L_ui", name: "ui", color: "0e8a16", description: null },
      ],
      assignees: [{ login: "alice", avatarUrl: "https://a.test/alice" }],
      type: { name: "Bug", color: "RED" },
      milestone: {
        title: "v1",
        url: "https://github.test/acme/web/milestone/1",
      },
      parent: { id: "I_parent", repo: "acme/web", number: 99 },
      sub: { total: 4, completed: 1 },
      totalBlockedBy: 2,
      totalBlocking: 3,
    });
    const rest = Array.from({ length: 100 }, (_, index) => issue(index + 2));
    addRepo({ name: "acme/web", id: "R_1", issues: [first, ...rest] });
    const sync = build(() => 1_700_000_000_000);

    expect(await sync.syncRepo("R_1")).toBe("synced");

    expect(issueRows()).toHaveLength(101);
    expect(issueRows()[0]).toEqual({
      id: "I_1",
      databaseId: 1001,
      repoId: "R_1",
      number: 1,
      title: "First",
      url: "https://github.test/acme/web/issues/1",
      authorLogin: "octocat",
      typeName: "Bug",
      typeColor: "RED",
      milestoneTitle: "v1",
      milestoneUrl: "https://github.test/acme/web/milestone/1",
      parentId: "I_parent",
      subTotal: 4,
      subCompleted: 1,
      blockedByTotal: 2,
      blockingTotal: 3,
      createdAt: Date.parse("2026-01-01T00:00:00Z"),
      updatedAt: Date.parse("2026-02-01T00:00:00Z"),
      syncedAt: 1_700_000_000_000,
    });
    expect(
      database.db
        .select({
          name: schema.labels.name,
          color: schema.labels.color,
          description: schema.labels.description,
          repoId: schema.labels.repoId,
        })
        .from(schema.labels)
        .orderBy(schema.labels.name)
        .all(),
    ).toEqual([
      { name: "bug", color: "d73a4a", description: "Broken", repoId: "R_1" },
      { name: "ui", color: "0e8a16", description: null, repoId: "R_1" },
    ]);
    expect(
      database.db
        .select()
        .from(schema.issueLabels)
        .all()
        .map((row) => row.labelId)
        .sort(),
    ).toEqual(["L_bug", "L_ui"]);
    expect(database.db.select().from(schema.issueAssignees).all()).toEqual([
      { issueId: "I_1", login: "alice", avatarUrl: "https://a.test/alice" },
    ]);
  });

  it("sends one query per page of 100 issues, following the cursor, and logs the page count and cost", async () => {
    addInstallation(1);
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: Array.from({ length: 150 }, (_, index) => issue(index + 1)),
    });
    await build().syncRepo("R_1");

    const pages = github.requestsFor("OpenIssuesPage");
    expect(pages.map((page) => page.variables)).toEqual([
      { owner: "acme", name: "web", after: null },
      { owner: "acme", name: "web", after: "100" },
    ]);
    const done = logs.find((entry) => entry.msg === "repository synced");
    expect(done).toMatchObject({
      level: 30,
      installationId: 1,
      repo: "acme/web",
      issues: 150,
      pages: 2,
      // the repository check and the two pages
      cost: 3 * COST,
    });
  });

  it("moves the repo from pending through syncing to ready and sets the sync times", async () => {
    addInstallation(1);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] });
    const states: string[] = [];
    github.world.failWith = () => {
      states.push(repoRow("R_1")?.syncState ?? "gone");
      return undefined;
    };
    let tick = 1_700_000_000_000;
    const sync = build(() => (tick += 1_000));
    expect(repoRow("R_1")?.syncState).toBe("pending");

    await sync.syncRepo("R_1");

    expect(states).toEqual(["syncing", "syncing"]);
    const row = repoRow("R_1");
    expect(row).toMatchObject({
      syncState: "ready",
      syncDetail: null,
      openIssueCount: 1,
    });
    // the start is read once the repo is claimed; the finish after the pages
    expect(Date.parse(row?.reconcileSince ?? "")).toBeLessThan(
      row?.lastFullSyncAt ?? 0,
    );
    expect(row?.reconcileSince).toMatch(/^2023-11-14T22:13:\d\d\.000Z$/);
  });

  it("replaces the repo's issues, so a re-sync drops the issue no longer returned and keeps the others", async () => {
    addInstallation(1);
    const repo: FakeRepo = {
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, { labels: [{ id: "L_a", name: "a", color: "111111" }] }),
        issue(2, {
          labels: [{ id: "L_b", name: "b", color: "222222" }],
          assignees: [{ login: "bob", avatarUrl: "https://a.test/bob" }],
        }),
        issue(3),
      ],
    };
    addRepo(repo);
    const sync = build();
    await sync.syncRepo("R_1");
    expect(issueRows().map((row) => row.number)).toEqual([1, 2, 3]);

    repo.issues = [
      issue(1, {
        title: "Renamed",
        labels: [{ id: "L_a", name: "a", color: "333333" }],
      }),
      issue(3),
    ];
    expect(await sync.syncRepo("R_1")).toBe("synced");

    expect(issueRows().map((row) => [row.number, row.title])).toEqual([
      [1, "Renamed"],
      [3, "Issue 3"],
    ]);
    expect(repoRow("R_1")?.openIssueCount).toBe(2);
    expect(
      database.db
        .select()
        .from(schema.labels)
        .all()
        .map((row) => [row.name, row.color]),
    ).toEqual([["a", "333333"]]);
    expect(database.db.select().from(schema.issueAssignees).all()).toEqual([]);
  });

  it("leaves what is stored untouched and marks the repo error with the message when a page fails after the client's retries", async () => {
    addInstallation(1);
    const repo: FakeRepo = {
      name: "acme/web",
      id: "R_1",
      issues: Array.from({ length: 150 }, (_, index) => issue(index + 1)),
    };
    addRepo(repo);
    const sync = build();
    await sync.syncRepo("R_1");
    expect(issueRows()).toHaveLength(150);

    repo.issues = [issue(1)];
    github.world.failWith = (request) =>
      request.name === "OpenIssuesPage" ? 502 : undefined;
    expect(await sync.syncRepo("R_1")).toBe("error");

    expect(issueRows()).toHaveLength(150);
    expect(repoRow("R_1")).toMatchObject({
      syncState: "error",
      syncDetail: "boom",
    });
    // the first request and the client's three retries
    expect(github.requestsFor("OpenIssuesPage").slice(-4)).toHaveLength(4);

    github.world.failWith = undefined;
    expect(await sync.syncRepo("R_1")).toBe("synced");
    expect(issueRows()).toHaveLength(1);
    expect(repoRow("R_1")).toMatchObject({
      syncState: "ready",
      syncDetail: null,
    });
  });

  it("marks a repo GitHub does not return error with a fixed message", async () => {
    addInstallation(1);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] });
    // an owner the fake does not know answers `repository: null`
    database.db
      .update(schema.repos)
      .set({ owner: "gone" })
      .where(eq(schema.repos.id, "R_1"))
      .run();
    expect(await build().syncRepo("R_1")).toBe("error");
    expect(repoRow("R_1")).toMatchObject({
      syncState: "error",
      syncDetail: "the repository is not readable",
    });
  });

  it.each([
    ["archived", { archived: true }],
    ["issues disabled", { issuesEnabled: false }],
  ])(
    "checks a repo discovery has not checked and marks it skipped when it is %s",
    async (reason, flags) => {
      addInstallation(1);
      addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)], ...flags });
      const sync = build();

      expect(await sync.syncRepo("R_1")).toBe("skipped");

      expect(repoRow("R_1")).toMatchObject({
        syncState: "skipped",
        syncDetail: reason,
        openIssueCount: 0,
      });
      expect(github.requestsFor("OpenIssuesPage")).toEqual([]);
      expect(issueRows()).toEqual([]);

      expect(await sync.syncRepo("R_1")).toBe("skipped");
      expect(github.world.requests).toHaveLength(1);
    },
  );

  it("does nothing for a repo of an inactive or suspended installation", async () => {
    addInstallation(1);
    addInstallation(2, true);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] }, 1);
    addRepo(
      { name: "acme/api", id: "R_2", issues: [issue(2, { repo: "acme/api" })] },
      2,
    );
    active.delete(1);
    const sync = build();

    expect(await sync.syncRepo("R_1")).toBe("skipped");
    expect(await sync.syncRepo("R_2")).toBe("skipped");
    expect(await sync.syncRepo("R_unknown")).toBe("skipped");

    expect(github.world.requests).toEqual([]);
    expect(repoRow("R_1")?.syncState).toBe("pending");
    expect(repoRow("R_2")?.syncState).toBe("pending");
  });

  it("writes nothing when the installation stops being active while the pages are fetched", async () => {
    addInstallation(1);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] });
    github.world.failWith = (request) => {
      if (request.name === "OpenIssuesPage") active.delete(1);
      return undefined;
    };

    expect(await build().syncRepo("R_1")).toBe("skipped");

    expect(issueRows()).toEqual([]);
    expect(repoRow("R_1")?.syncState).toBe("pending");
  });

  it("returns the repo to pending when the installation stops being active while a page fails", async () => {
    addInstallation(1);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] });
    github.world.failWith = (request) => {
      if (request.name !== "OpenIssuesPage") return undefined;
      active.delete(1);
      return 502;
    };

    expect(await build().syncRepo("R_1")).toBe("error");

    expect(issueRows()).toEqual([]);
    expect(repoRow("R_1")?.syncState).toBe("pending");
  });

  it("does not run twice for one repo at once", async () => {
    addInstallation(1);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] });
    const sync = build();
    const outcomes = await Promise.all([
      sync.syncRepo("R_1"),
      sync.syncRepo("R_1"),
    ]);
    expect(outcomes.sort()).toEqual(["skipped", "synced"]);
    expect(github.requestsFor("OpenIssuesPage")).toHaveLength(1);
  });
});

describe("the sync job", () => {
  it("syncs a repo through the job queue and resumes pending and syncing repos of active installations at start", async () => {
    addInstallation(1);
    addInstallation(2);
    active.delete(2);
    addRepo({ name: "acme/web", id: "R_1", issues: [issue(1)] }, 1, "pending");
    addRepo(
      { name: "acme/api", id: "R_2", issues: [issue(2, { repo: "acme/api" })] },
      1,
      "syncing",
    );
    addRepo({ name: "acme/ready", id: "R_3", issues: [] }, 1, "ready");
    addRepo(
      { name: "acme/off", id: "R_4", issues: [issue(4, { repo: "acme/off" })] },
      2,
      "pending",
    );
    const sync = build();
    const logger = createLogger("silent");
    const jobs = createJobs({ logger });
    registerSyncJob(jobs, sync);
    jobs.start();

    enqueueSyncAtStart(jobs, database.db, { users: [], orgs: ["acct-1"] });
    await jobs.stop();

    expect(SYNC_JOB).toBe("sync.repo");
    expect(repoRow("R_1")?.syncState).toBe("ready");
    expect(repoRow("R_2")?.syncState).toBe("ready");
    expect(repoRow("R_3")?.syncState).toBe("ready");
    expect(repoRow("R_4")?.syncState).toBe("pending");
    expect(issueRows().map((row) => row.id)).toEqual(["I_1", "I_2"]);
  });
});

describe("relations", () => {
  const ref = (
    number: number,
    repo = "acme/api",
    state: "OPEN" | "CLOSED" = "OPEN",
  ): FakeRef => ({
    // the ids of acme/web issues are the ones `issue` gives them
    id:
      repo === "acme/web"
        ? `I_${String(number)}`
        : `I_${repo.replace("/", "_")}_${String(number)}`,
    repo,
    number,
    state,
  });
  const refRows = () =>
    database.db
      .select()
      .from(schema.issueRefs)
      .orderBy(schema.issueRefs.id)
      .all();
  const depRows = () =>
    database.db
      .select({
        blocked: schema.issueDeps.blockedId,
        blocking: schema.issueDeps.blockingId,
      })
      .from(schema.issueDeps)
      .orderBy(schema.issueDeps.blockedId, schema.issueDeps.blockingId)
      .all();

  it("stores a ref for every parent and every issue on either side of a dependency, and one edge per readable edge", async () => {
    addInstallation(1);
    const crossRepo = ref(7, "acme/api");
    const closed = ref(8, "acme/web", "CLOSED");
    const blocked = ref(9, "acme/api");
    const parent = ref(10, "acme/web");
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, {
          title: "Needs the API",
          blockedBy: [crossRepo, closed],
          blocking: [blocked],
          parent,
        }),
      ],
    });
    const before = Date.now();

    await build().syncRepo("R_1");

    expect(
      refRows().map((row) => [
        row.repoFullName,
        row.number,
        row.title,
        row.state,
        row.url,
      ]),
    ).toEqual(
      [
        [
          "acme/web",
          1,
          "Needs the API",
          "OPEN",
          "https://github.test/acme/web/issues/1",
        ],
        [
          "acme/api",
          7,
          "Issue 7",
          "OPEN",
          "https://github.test/acme/api/issues/7",
        ],
        [
          "acme/web",
          8,
          "Issue 8",
          "CLOSED",
          "https://github.test/acme/web/issues/8",
        ],
        [
          "acme/api",
          9,
          "Issue 9",
          "OPEN",
          "https://github.test/acme/api/issues/9",
        ],
        [
          "acme/web",
          10,
          "Issue 10",
          "OPEN",
          "https://github.test/acme/web/issues/10",
        ],
      ].sort((a, b) =>
        String(ref(Number(a[1]), String(a[0]), "OPEN").id).localeCompare(
          ref(Number(b[1]), String(b[0]), "OPEN").id,
        ),
      ),
    );
    expect(refRows().every((row) => row.seenAt >= before)).toBe(true);
    expect(depRows()).toEqual(
      [
        { blocked: "I_1", blocking: crossRepo.id },
        { blocked: "I_1", blocking: closed.id },
        { blocked: blocked.id, blocking: "I_1" },
      ].sort(
        (a, b) =>
          a.blocked.localeCompare(b.blocked) ||
          a.blocking.localeCompare(b.blocking),
      ),
    );
    expect(issueRows()[0]?.parentId).toBe(parent.id);
  });

  it("deduplicates an edge named from both sides", async () => {
    addInstallation(1);
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, { blockedBy: [ref(2, "acme/web")] }),
        issue(2, { blocking: [ref(1, "acme/web")] }),
      ],
    });
    await build().syncRepo("R_1");
    expect(depRows()).toEqual([{ blocked: "I_1", blocking: "I_2" }]);
    expect(refRows().filter((row) => row.id === "I_1")).toHaveLength(1);
  });

  it("pages 25 blockers and 25 labels and 12 assignees by follow-up queries for the issue", async () => {
    addInstallation(1);
    const blockers = Array.from({ length: 25 }, (_, index) =>
      ref(100 + index, "acme/api"),
    );
    const labelList = Array.from({ length: 25 }, (_, index) => ({
      id: `L_${String(index)}`,
      name: `label-${String(index)}`,
      color: "ededed",
    }));
    const assigneeList = Array.from({ length: 12 }, (_, index) => ({
      login: `user-${String(index)}`,
      avatarUrl: `https://a.test/${String(index)}`,
    }));
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, {
          blockedBy: blockers,
          labels: labelList,
          assignees: assigneeList,
        }),
        issue(2),
      ],
    });

    await build().syncRepo("R_1");

    expect(depRows()).toHaveLength(25);
    expect(database.db.select().from(schema.issueLabels).all()).toHaveLength(
      25,
    );
    expect(database.db.select().from(schema.issueAssignees).all()).toHaveLength(
      12,
    );
    expect(issueRows()[0]).toMatchObject({ blockedByTotal: 25 });
    const followUps = github.requestsFor("IssueConnectionsPage");
    // each connection needs one more page, and they are asked for together
    expect(followUps.map((request) => request.variables)).toEqual([
      {
        id: "I_1",
        labels: true,
        labelsAfter: "20",
        assignees: true,
        assigneesAfter: "10",
        blockedBy: true,
        blockedByAfter: "20",
        blocking: false,
        blockingAfter: null,
      },
    ]);
  });

  it("follows a connection through several follow-up pages", async () => {
    addInstallation(1);
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, {
          blocking: Array.from({ length: 45 }, (_, index) =>
            ref(200 + index, "acme/api"),
          ),
        }),
      ],
    });
    await build().syncRepo("R_1");
    expect(depRows()).toHaveLength(45);
    expect(
      github
        .requestsFor("IssueConnectionsPage")
        .map((request) => request.variables.blockingAfter),
    ).toEqual(["20", "40"]);
  });

  it("keeps GitHub's totals, so a total above the readable count is the not-accessible count", async () => {
    addInstallation(1);
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, {
          blockedBy: [ref(7)],
          totalBlockedBy: 3,
          blocking: [],
          totalBlocking: 1,
        }),
      ],
    });
    await build().syncRepo("R_1");
    const stored = issueRows()[0];
    const readable = (side: "blocked" | "blocking") =>
      depRows().filter((row) => row[side] === "I_1").length;
    expect(stored).toMatchObject({ blockedByTotal: 3, blockingTotal: 1 });
    expect(
      Math.max(0, (stored?.blockedByTotal ?? 0) - readable("blocked")),
    ).toBe(2);
    expect(
      Math.max(0, (stored?.blockingTotal ?? 0) - readable("blocking")),
    ).toBe(1);
  });

  it("replaces the edges of the fetched issues, so a dependency removed on GitHub is gone after both repos resync", async () => {
    addInstallation(1);
    const web: FakeRepo = {
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, { blockedBy: [ref(2, "acme/web"), ref(9, "acme/api")] }),
        issue(2),
      ],
    };
    const api: FakeRepo = {
      name: "acme/api",
      id: "R_2",
      issues: [
        issue(9, {
          id: ref(9).id,
          repo: "acme/api",
          blocking: [ref(1, "acme/web")],
        }),
      ],
    };
    addRepo(web);
    addRepo(api);
    const sync = build();
    await sync.syncRepo("R_1");
    await sync.syncRepo("R_2");
    expect(depRows()).toEqual(
      [
        { blocked: "I_1", blocking: "I_2" },
        { blocked: "I_1", blocking: ref(9).id },
      ].sort((a, b) => a.blocking.localeCompare(b.blocking)),
    );

    // the dependency on acme/api#9 is removed on GitHub
    web.issues = [issue(1, { blockedBy: [ref(2, "acme/web")] }), issue(2)];
    api.issues = [issue(9, { id: ref(9).id, repo: "acme/api" })];
    await sync.syncRepo("R_1");
    await sync.syncRepo("R_2");

    expect(depRows()).toEqual([{ blocked: "I_1", blocking: "I_2" }]);
  });

  it("keeps an edge whose end in the repo this sync did not fetch", async () => {
    addInstallation(1);
    const repo: FakeRepo = {
      name: "acme/web",
      id: "R_1",
      issues: [issue(1, { blockedBy: [ref(7, "acme/api")] })],
    };
    addRepo(repo);
    const sync = build();
    await sync.syncRepo("R_1");

    // the closed acme/web#8 is not fetched; its edges belong to the sync of the other repo
    database.db
      .insert(schema.issueRefs)
      .values({
        id: ref(8, "acme/web", "CLOSED").id,
        repoFullName: "acme/web",
        number: 8,
        title: "Issue 8",
        state: "CLOSED",
        url: "https://github.test/acme/web/issues/8",
        seenAt: 1,
      })
      .run();
    database.db
      .insert(schema.issueDeps)
      .values({
        blockedId: ref(8, "acme/web", "CLOSED").id,
        blockingId: ref(7, "acme/api").id,
      })
      .run();

    await sync.syncRepo("R_1");

    expect(depRows()).toEqual(
      [
        { blocked: "I_1", blocking: ref(7, "acme/api").id },
        {
          blocked: ref(8, "acme/web", "CLOSED").id,
          blocking: ref(7, "acme/api").id,
        },
      ].sort(
        (a, b) =>
          a.blocked.localeCompare(b.blocked) ||
          a.blocking.localeCompare(b.blocking),
      ),
    );
  });

  it("marks the repo error and replaces nothing when a follow-up query fails", async () => {
    addInstallation(1);
    addRepo({
      name: "acme/web",
      id: "R_1",
      issues: [
        issue(1, {
          blockedBy: Array.from({ length: 25 }, (_, index) => ref(100 + index)),
        }),
      ],
    });
    github.world.failWith = (request) =>
      request.name === "IssueConnectionsPage" ? 502 : undefined;

    expect(await build().syncRepo("R_1")).toBe("error");

    expect(repoRow("R_1")).toMatchObject({
      syncState: "error",
      syncDetail: "boom",
    });
    expect(issueRows()).toEqual([]);
    expect(refRows()).toEqual([]);
    expect(depRows()).toEqual([]);
  });
});
