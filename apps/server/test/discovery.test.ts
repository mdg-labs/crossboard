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
} from "vitest";
import type { GithubAppCredentials } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import {
  createGithubClient,
  createInstallationClient,
} from "../src/github/index.js";
import { queries } from "../src/github/queries/index.js";
import { purgeInstallations } from "../src/access/purge.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import {
  createDiscovery,
  DISCOVERY_JOB,
  REPOSITORY_STATES_BATCH,
  enqueueDiscovery,
  registerDiscoveryJob,
  registerDiscoverySchedule,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_SCHEDULE_JOB,
} from "../src/sync/discovery.js";
import { assertReadOnlyDocument } from "../src/github/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { addUser } from "./sign-in.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
} from "./github-fake.js";

interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private?: boolean;
  archived?: boolean;
  issuesEnabled?: boolean;
  openIssues?: number;
}

const fake = createFakeGithub();
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
let listing: Record<number, FakeRepo[]>;
let listingVersion: number;
let listRequests: {
  installation: number;
  page: string;
  ifNoneMatch: string | null;
}[];
let graphqlBatches: number[];
let graphqlFails: boolean;
let active: Set<number>;
let queued: { id: string; installationId: number }[][];

beforeAll(() => fake.listen());
afterAll(() => fake.close());

const nodeId = (repo: FakeRepo) => `R_${String(repo.id)}`;
const installationOf = (request: Request) =>
  Number(
    (request.headers.get("authorization") ?? "").replace(
      "Bearer ghs_fake_for_",
      "",
    ),
  );

beforeEach(() => {
  database = createTestDatabase();
  logs = [];
  listing = {};
  listingVersion = 1;
  listRequests = [];
  graphqlBatches = [];
  graphqlFails = false;
  active = new Set();
  queued = [];
  fake.server.use(
    http.post(
      `${FAKE_API_URL}/app/installations/:installationId/access_tokens`,
      ({ params }) =>
        HttpResponse.json(
          {
            token: `ghs_fake_for_${String(params.installationId)}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { status: 201 },
        ),
    ),
    http.get(`${FAKE_API_URL}/installation/repositories`, ({ request }) => {
      const url = new URL(request.url);
      const installation = installationOf(request);
      const page = url.searchParams.get("page") ?? "1";
      const ifNoneMatch = request.headers.get("if-none-match");
      listRequests.push({ installation, page, ifNoneMatch });
      const perPage = Number(url.searchParams.get("per_page"));
      const all = listing[installation] ?? [];
      const slice = all.slice(
        (Number(page) - 1) * perPage,
        Number(page) * perPage,
      );
      const etag = `"v${String(listingVersion)}-${page}-${String(slice.length)}"`;
      if (ifNoneMatch === etag) return new HttpResponse(null, { status: 304 });
      return HttpResponse.json(
        {
          total_count: all.length,
          repositories: slice.map((repo) => ({
            id: repo.id,
            node_id: nodeId(repo),
            name: repo.name,
            full_name: `${repo.owner}/${repo.name}`,
            owner: { id: 1, login: repo.owner },
            private: repo.private ?? false,
          })),
        },
        { headers: { etag } },
      );
    }),
    http.post(`${FAKE_API_URL}/graphql`, async ({ request }) => {
      if (graphqlFails) {
        return HttpResponse.json({ message: "boom" }, { status: 500 });
      }
      const { variables } = (await request.json()) as {
        variables: { ids: string[] };
      };
      const installation = installationOf(request);
      graphqlBatches.push(variables.ids.length);
      const data = {
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-01-01T00:00:00Z",
        },
        nodes: variables.ids.map((id) => {
          const repo = (listing[installation] ?? []).find(
            (entry) => nodeId(entry) === id,
          );
          return repo === undefined
            ? null
            : {
                id,
                isArchived: repo.archived ?? false,
                hasIssuesEnabled: repo.issuesEnabled ?? true,
                issues: { totalCount: repo.openIssues ?? 0 },
              };
        }),
      };
      return HttpResponse.json({ data });
    }),
  );
});

afterEach(() => {
  fake.reset();
  database.cleanup();
});

function build(now?: () => number) {
  const logger = createLogger("trace", {
    write: (chunk) => logs.push(JSON.parse(chunk)),
  });
  const github = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    sleep: () => Promise.resolve(),
    logger,
  });
  const installations = createInstallationClient({
    github,
    credentials: () => credentials,
  });
  const discovery = createDiscovery({
    db: database.db,
    installations,
    isActive: (id) => active.has(id),
    logger,
    onPending: (pending) => queued.push(pending),
    ...(now === undefined ? {} : { now }),
  });
  return { discovery, logger };
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

const repoRow = (id: number) =>
  database.db
    .select()
    .from(schema.repos)
    .where(eq(schema.repos.id, `R_${String(id)}`))
    .get();
const allRepos = () => database.db.select().from(schema.repos).all();

describe("the repository state query", () => {
  it("is registered and read-only", () => {
    expect(() => {
      assertReadOnlyDocument(queries.repositoryStates.document);
    }).not.toThrow();
  });
});

describe("repository discovery", () => {
  it("lists every page and records identity, installation and the private flag", async () => {
    addInstallation(1);
    listing[1] = Array.from({ length: 230 }, (_, index) => ({
      id: index + 1,
      owner: "acme",
      name: `repo-${String(index + 1)}`,
      private: index % 2 === 0,
      openIssues: 3,
    }));
    const { discovery } = build();
    expect(await discovery.discover(1)).toBe("discovered");
    expect(listRequests.map((request) => request.page)).toEqual([
      "1",
      "2",
      "3",
    ]);
    const rows = allRepos();
    expect(rows).toHaveLength(230);
    expect(repoRow(1)).toMatchObject({
      databaseId: 1,
      installationId: 1,
      owner: "acme",
      name: "repo-1",
      private: true,
    });
    expect(repoRow(2)).toMatchObject({ private: false });
  });

  it("checks the repos in queries of at most 25", async () => {
    addInstallation(1);
    listing[1] = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      owner: "acme",
      name: `repo-${String(index + 1)}`,
      openIssues: 1,
    }));
    const { discovery } = build();
    await discovery.discover(1);
    expect(REPOSITORY_STATES_BATCH).toBe(25);
    expect(graphqlBatches).toEqual([25, 25, 10]);
  });

  it("skips archived and issues-disabled repos with the reason, marks empty ones ready and leaves the rest pending with their count", async () => {
    addInstallation(1);
    listing[1] = [
      { id: 1, owner: "acme", name: "old", archived: true, openIssues: 4 },
      { id: 2, owner: "acme", name: "no-issues", issuesEnabled: false },
      { id: 3, owner: "acme", name: "empty", openIssues: 0 },
      { id: 4, owner: "acme", name: "busy", openIssues: 42 },
    ];
    const { discovery } = build(() => 1_700_000_000_000);
    await discovery.discover(1);
    expect(repoRow(1)).toMatchObject({
      syncState: "skipped",
      syncDetail: "archived",
      openIssueCount: 0,
    });
    expect(repoRow(2)).toMatchObject({
      syncState: "skipped",
      syncDetail: "issues disabled",
    });
    expect(repoRow(3)).toMatchObject({
      syncState: "ready",
      syncDetail: null,
      openIssueCount: 0,
      lastFullSyncAt: 1_700_000_000_000,
      reconcileSince: "2023-11-14T22:13:20.000Z",
    });
    expect(repoRow(4)).toMatchObject({
      syncState: "pending",
      syncDetail: null,
      openIssueCount: 42,
    });
  });

  it("hands the installation's pending repos on to be synced", async () => {
    addInstallation(1);
    listing[1] = [
      { id: 1, owner: "acme", name: "old", archived: true, openIssues: 4 },
      { id: 2, owner: "acme", name: "empty", openIssues: 0 },
      { id: 3, owner: "acme", name: "busy", openIssues: 42 },
    ];
    const { discovery } = build();
    await discovery.discover(1);
    expect(queued).toEqual([[{ id: "R_3", installationId: 1 }]]);
  });

  it("hands nothing on for an installation that is not active", async () => {
    addInstallation(1);
    active.clear();
    const { discovery } = build();
    await discovery.discover(1);
    expect(queued).toEqual([]);
  });

  it("sends the stored ETag of each page and keeps the repos when GitHub answers 304", async () => {
    addInstallation(1);
    listing[1] = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      owner: "acme",
      name: `repo-${String(index + 1)}`,
      openIssues: 1,
    }));
    const { discovery } = build();
    await discovery.discover(1);
    expect(listRequests.every((request) => request.ifNoneMatch !== null)).toBe(
      true,
    );
    listRequests.length = 0;
    expect(await discovery.discover(1)).toBe("discovered");
    expect(listRequests).toEqual([
      { installation: 1, page: "1", ifNoneMatch: '"v1-1-100"' },
      { installation: 1, page: "2", ifNoneMatch: '"v1-2-1"' },
    ]);
    expect(allRepos()).toHaveLength(101);
  });

  it("picks up a repo added while the first page was unchanged", async () => {
    addInstallation(1);
    listing[1] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      owner: "acme",
      name: `repo-${String(index + 1)}`,
      openIssues: 1,
    }));
    const { discovery } = build();
    await discovery.discover(1);
    listing[1].push({
      id: 101,
      owner: "acme",
      name: "repo-101",
      openIssues: 1,
    });
    await discovery.discover(1);
    expect(allRepos()).toHaveLength(101);
  });

  it("refreshes a repo's identity but keeps the state of one past pending", async () => {
    addInstallation(1);
    addInstallation(2);
    database.db
      .insert(schema.repos)
      .values({
        id: "R_1",
        databaseId: 1,
        installationId: 2,
        owner: "acme",
        name: "before",
        private: false,
        syncState: "ready",
        openIssueCount: 9,
        lastFullSyncAt: 5,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    listing[1] = [
      { id: 1, owner: "acme", name: "after", private: true, openIssues: 77 },
    ];
    const { discovery } = build();
    await discovery.discover(1);
    expect(repoRow(1)).toMatchObject({
      installationId: 1,
      name: "after",
      private: true,
      syncState: "ready",
      openIssueCount: 9,
      lastFullSyncAt: 5,
    });
    expect(graphqlBatches).toEqual([]);
  });

  it("keeps the state of a repo a sync moved on while the GitHub calls ran", async () => {
    addInstallation(1);
    database.db
      .insert(schema.repos)
      .values({
        id: "R_1",
        databaseId: 1,
        installationId: 1,
        owner: "acme",
        name: "r",
        private: false,
        syncState: "pending",
        openIssueCount: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 4 }];
    fake.server.use(
      http.post(
        `${FAKE_API_URL}/graphql`,
        () => {
          database.db
            .update(schema.repos)
            .set({ syncState: "syncing" })
            .where(eq(schema.repos.id, "R_1"))
            .run();
          return undefined;
        },
        { once: true },
      ),
    );
    const { discovery } = build();
    await discovery.discover(1);
    expect(repoRow(1)).toMatchObject({ syncState: "syncing" });
    expect(queued).toEqual([[]]);
  });

  it("moves a skipped repo to pending once it is no longer archived", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", archived: true }];
    const { discovery } = build();
    await discovery.discover(1);
    expect(repoRow(1)?.syncState).toBe("skipped");
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 5 }];
    listingVersion++;
    await discovery.discover(1);
    expect(repoRow(1)).toMatchObject({
      syncState: "pending",
      syncDetail: null,
      openIssueCount: 5,
    });
  });

  it("records a repo the response carries no state for as pending with no count", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 2 }];
    const { discovery } = build();
    fake.server.use(
      http.post(`${FAKE_API_URL}/graphql`, () =>
        HttpResponse.json({
          data: { rateLimit: { cost: 1, remaining: 1 }, nodes: [null] },
        }),
      ),
    );
    await discovery.discover(1);
    expect(repoRow(1)).toMatchObject({
      syncState: "pending",
      openIssueCount: 0,
    });
  });

  it.each([
    ["unknown", () => undefined],
    ["suspended", () => addInstallation(3, true)],
    [
      "not active",
      () => {
        addInstallation(3);
        active.delete(3);
      },
    ],
  ])("does nothing for an installation that is %s", async (_label, arrange) => {
    arrange();
    listing[3] = [{ id: 1, owner: "acme", name: "r", openIssues: 1 }];
    const { discovery } = build();
    expect(await discovery.discover(3)).toBe("skipped");
    expect(listRequests).toEqual([]);
    expect(graphqlBatches).toEqual([]);
    expect(allRepos()).toEqual([]);
  });

  it("writes nothing when the state query fails", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 1 }];
    graphqlFails = true;
    const { discovery } = build();
    await expect(discovery.discover(1)).rejects.toThrow();
    expect(allRepos()).toEqual([]);
  });

  it("writes nothing when listing the repositories fails", async () => {
    addInstallation(1);
    fake.server.use(
      http.get(`${FAKE_API_URL}/installation/repositories`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const { discovery } = build();
    await expect(discovery.discover(1)).rejects.toThrow();
    expect(allRepos()).toEqual([]);
  });

  it("leaves a repo that clashes with a stored one by name out", async () => {
    addInstallation(1);
    addInstallation(2);
    database.db
      .insert(schema.repos)
      .values({
        id: "R_99",
        databaseId: 99,
        installationId: 2,
        owner: "acme",
        name: "r",
        private: false,
        syncState: "ready",
        openIssueCount: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    listing[1] = [
      { id: 1, owner: "acme", name: "r", openIssues: 1 },
      { id: 2, owner: "acme", name: "other", openIssues: 1 },
    ];
    const { discovery } = build();
    await discovery.discover(1);
    expect(
      allRepos()
        .map((row) => row.id)
        .sort(),
    ).toEqual(["R_2", "R_99"]);
  });

  it("writes nothing when GitHub reports a listed repo as not found", async () => {
    addInstallation(1);
    listing[1] = [
      { id: 1, owner: "acme", name: "r", openIssues: 2 },
      { id: 2, owner: "acme", name: "gone", openIssues: 2 },
    ];
    const { discovery } = build();
    fake.server.use(
      http.post(`${FAKE_API_URL}/graphql`, () =>
        HttpResponse.json({
          data: {
            rateLimit: { cost: 1, remaining: 1 },
            nodes: [
              {
                id: "R_1",
                isArchived: false,
                hasIssuesEnabled: true,
                issues: { totalCount: 2 },
              },
              null,
            ],
          },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["nodes", 1],
              message:
                "Could not resolve to a node with the global id of 'R_2'",
            },
          ],
        }),
      ),
    );
    await expect(discovery.discover(1)).rejects.toThrow();
    expect(allRepos()).toEqual([]);
  });

  it("writes nothing when the installation is purged while discovery is waiting on GitHub", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 2 }];
    const { discovery } = build();
    fake.server.use(
      http.post(`${FAKE_API_URL}/graphql`, () => {
        active.delete(1);
        purgeInstallations(database.db, [1]);
        return HttpResponse.json({
          data: {
            rateLimit: { cost: 1, remaining: 1 },
            nodes: [
              {
                id: "R_1",
                isArchived: false,
                hasIssuesEnabled: true,
                issues: { totalCount: 2 },
              },
            ],
          },
        });
      }),
    );
    expect(await discovery.discover(1)).toBe("skipped");
    expect(allRepos()).toEqual([]);
  });

  it("keeps a renamed repo's stored name when it clashes with a stale row, and records the rest", async () => {
    addInstallation(1);
    addInstallation(2);
    const stored = (id: number, name: string, installationId: number) =>
      database.db
        .insert(schema.repos)
        .values({
          id: `R_${String(id)}`,
          databaseId: id,
          installationId,
          owner: "acme",
          name,
          private: false,
          syncState: "pending",
          openIssueCount: 0,
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
    stored(1, "r", 2);
    stored(2, "old", 1);
    listing[1] = [
      { id: 2, owner: "acme", name: "r", private: true, openIssues: 3 },
      { id: 3, owner: "acme", name: "fresh", openIssues: 1 },
    ];
    const { discovery } = build();
    expect(await discovery.discover(1)).toBe("discovered");
    expect(repoRow(2)).toMatchObject({
      name: "old",
      private: true,
      openIssueCount: 3,
    });
    expect(repoRow(1)?.name).toBe("r");
    expect(repoRow(3)?.name).toBe("fresh");
  });

  describe("a stored repo the listing no longer contains", () => {
    const store = (
      id: number,
      installationId: number,
      extra: Partial<typeof schema.repos.$inferInsert> = {},
    ) =>
      database.db
        .insert(schema.repos)
        .values({
          id: `R_${String(id)}`,
          databaseId: id,
          installationId,
          owner: "acme",
          name: `repo-${String(id)}`,
          private: false,
          syncState: "pending",
          openIssueCount: 0,
          createdAt: 1,
          updatedAt: 1,
          ...extra,
        })
        .run();
    const count = (table: SQLiteTable) =>
      database.db.select().from(table).all().length;

    it("is purged with its access, issues and dependencies, and boards, columns and saved views stay", async () => {
      addInstallation(1);
      const alice = addUser(database.db, "alice");
      store(1, 1);
      store(2, 1, { syncState: "ready" });
      database.db
        .insert(schema.userRepoAccess)
        .values([
          { userId: alice.id, repoId: "R_1", computedAt: 1 },
          { userId: alice.id, repoId: "R_2", computedAt: 1 },
        ])
        .run();
      database.db
        .insert(schema.issues)
        .values({
          id: "I_2",
          databaseId: 5,
          repoId: "R_2",
          number: 1,
          title: "t",
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
      database.db
        .insert(schema.issueDeps)
        .values({ blockedId: "I_2", blockingId: "I_elsewhere" })
        .run();
      const board = database.db
        .insert(schema.boards)
        .values({
          userId: alice.id,
          name: "b",
          baseFilter: "repo:acme/repo-1",
          sort: "updated",
          subIssueMode: "flat",
          showOther: false,
          createdAt: 1,
          updatedAt: 1,
        })
        .returning()
        .get();
      database.db
        .insert(schema.boardColumns)
        .values({ boardId: board.id, position: 0, name: "c", filter: "x" })
        .run();
      database.db
        .insert(schema.savedViews)
        .values({
          userId: alice.id,
          name: "v",
          filter: "repo:acme/repo-1",
          sort: "updated",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      listing[1] = [{ id: 3, owner: "acme", name: "kept", openIssues: 1 }];

      const { discovery } = build();
      expect(await discovery.discover(1)).toBe("discovered");

      expect(allRepos().map((row) => row.id)).toEqual(["R_3"]);
      expect(count(schema.userRepoAccess)).toBe(0);
      expect(count(schema.issues)).toBe(0);
      expect(count(schema.issueDeps)).toBe(0);
      expect(count(schema.boards)).toBe(1);
      expect(count(schema.boardColumns)).toBe(1);
      expect(count(schema.savedViews)).toBe(1);
      expect(queued).toEqual([[{ id: "R_3", installationId: 1 }]]);
    });

    it("is kept when it belongs to another installation", async () => {
      addInstallation(1);
      addInstallation(2);
      store(1, 2);
      listing[1] = [{ id: 3, owner: "acme", name: "kept" }];
      const { discovery } = build();
      await discovery.discover(1);
      expect(
        allRepos()
          .map((row) => row.id)
          .sort(),
      ).toEqual(["R_1", "R_3"]);
    });

    it("is kept when it was stored after the listing began, and purged by the next discovery", async () => {
      addInstallation(1);
      store(1, 1);
      listing[1] = [{ id: 3, owner: "acme", name: "kept" }];
      let clock = 1000;
      fake.server.use(
        http.get(
          `${FAKE_API_URL}/installation/repositories`,
          () => {
            store(2, 1, { createdAt: 1001 });
            return undefined;
          },
          { once: true },
        ),
      );
      const { discovery } = build(() => clock);
      await discovery.discover(1);
      expect(
        allRepos()
          .map((row) => row.id)
          .sort(),
      ).toEqual(["R_2", "R_3"]);
      clock = 2000;
      listingVersion++;
      await discovery.discover(1);
      expect(allRepos().map((row) => row.id)).toEqual(["R_3"]);
    });

    it("is kept when listing the repositories fails", async () => {
      addInstallation(1);
      store(1, 1);
      fake.server.use(
        http.get(`${FAKE_API_URL}/installation/repositories`, () =>
          HttpResponse.json({ message: "bad gateway" }, { status: 502 }),
        ),
      );
      const { discovery } = build();
      await expect(discovery.discover(1)).rejects.toThrow();
      expect(allRepos().map((row) => row.id)).toEqual(["R_1"]);
    });

    // The first request for page 1 is the first listing; the next one is the
    // second listing, which `answer` replaces. A request it returns nothing
    // for is served by the default handler.
    const secondListing = (
      answer: (page: number) => Response | undefined,
    ): void => {
      let firstPages = 0;
      fake.server.use(
        http.get(`${FAKE_API_URL}/installation/repositories`, ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get("page"));
          if (page === 1) firstPages++;
          return firstPages < 2 ? undefined : answer(page);
        }),
      );
    };
    const entry = (id: number) => ({
      id,
      node_id: `R_${String(id)}`,
      name: `repo-${String(id)}`,
      owner: { id: 1, login: "acme" },
      private: false,
    });
    const warned = () =>
      logs.some(
        (log) =>
          log.level === 40 &&
          String(log.msg).includes("could not be confirmed removed"),
      );

    it("keeps a repo that is still installed when the listing shifts between its pages", async () => {
      addInstallation(1);
      const all = Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        owner: "acme",
        name: `repo-${String(index + 1)}`,
      }));
      listing[1] = all;
      for (const repo of all) store(repo.id, 1, { syncState: "ready" });
      let shifted = false;
      fake.server.use(
        http.get(`${FAKE_API_URL}/installation/repositories`, ({ request }) => {
          const page = new URL(request.url).searchParams.get("page");
          if (!shifted && page === "2") {
            shifted = true;
            listing[1] = all.slice(1);
          } else if (shifted && page === "1") listing[1] = all;
          return undefined;
        }),
      );
      const { discovery } = build();
      expect(await discovery.discover(1)).toBe("discovered");
      expect(shifted).toBe(true);
      expect(allRepos()).toHaveLength(150);
      expect(repoRow(101)).toBeDefined();
    });

    it("is purged when the installation token can still read it, as a public repo outside the selection", async () => {
      addInstallation(1);
      store(1, 1);
      store(2, 1, { syncState: "ready" });
      listing[1] = [{ id: 4, owner: "acme", name: "kept" }];
      fake.server.use(
        http.post(`${FAKE_API_URL}/graphql`, async ({ request }) => {
          const { variables } = (await request.json()) as {
            variables: { ids: string[] };
          };
          return HttpResponse.json({
            data: {
              rateLimit: { cost: 1, remaining: 1 },
              nodes: variables.ids.map((id) => ({
                id,
                isArchived: false,
                hasIssuesEnabled: true,
                issues: { totalCount: 0 },
              })),
            },
          });
        }),
      );
      const { discovery } = build();
      await discovery.discover(1);
      expect(
        allRepos()
          .map((row) => row.id)
          .sort(),
      ).toEqual(["R_4"]);
    });

    it("keeps every missing repo, and still applies the rest, when the second listing fails", async () => {
      addInstallation(1);
      store(1, 1);
      store(2, 1, { syncState: "ready" });
      listing[1] = [{ id: 2, owner: "acme", name: "renamed" }];
      secondListing(() =>
        HttpResponse.json({ message: "bad gateway" }, { status: 502 }),
      );
      const { discovery } = build();
      expect(await discovery.discover(1)).toBe("discovered");
      expect(
        allRepos()
          .map((row) => row.id)
          .sort(),
      ).toEqual(["R_1", "R_2"]);
      expect(repoRow(2)?.name).toBe("renamed");
      expect(warned()).toBe(true);
    });

    it("keeps every missing repo when the second listing's total_count changes between pages", async () => {
      addInstallation(1);
      store(1, 1);
      listing[1] = [{ id: 4, owner: "acme", name: "kept" }];
      secondListing((page) =>
        page === 1
          ? HttpResponse.json({
              total_count: 101,
              repositories: Array.from({ length: 100 }, (_, i) =>
                entry(1000 + i),
              ),
            })
          : HttpResponse.json({
              total_count: 102,
              repositories: [entry(2000)],
            }),
      );
      const { discovery } = build();
      await discovery.discover(1);
      expect(repoRow(1)).toBeDefined();
      expect(repoRow(4)).toBeDefined();
      expect(warned()).toBe(true);
    });

    it.each([
      ["fewer repos than its total_count", 5, [4, 5, 6]],
      ["more repos than its total_count", 1, [4, 5, 6]],
    ])(
      "keeps every missing repo when the second listing has %s",
      async (_name, total, ids) => {
        addInstallation(1);
        store(1, 1);
        listing[1] = [{ id: 4, owner: "acme", name: "kept" }];
        secondListing(() =>
          HttpResponse.json({
            total_count: total,
            repositories: ids.map(entry),
          }),
        );
        const { discovery } = build();
        await discovery.discover(1);
        expect(repoRow(1)).toBeDefined();
        expect(warned()).toBe(true);
      },
    );

    it("keeps every missing repo when the second listing carries no total_count", async () => {
      addInstallation(1);
      store(1, 1);
      listing[1] = [{ id: 4, owner: "acme", name: "kept" }];
      secondListing(() => HttpResponse.json({ repositories: [entry(4)] }));
      const { discovery } = build();
      await discovery.discover(1);
      expect(repoRow(1)).toBeDefined();
      expect(warned()).toBe(true);
    });

    it("lists only once when nothing is missing from the listing", async () => {
      addInstallation(1);
      store(1, 1, { syncState: "ready" });
      listing[1] = [{ id: 1, owner: "acme", name: "repo-1" }];
      const { discovery } = build();
      await discovery.discover(1);
      expect(listRequests).toHaveLength(1);
    });

    it("is purged only when both listings lack it", async () => {
      addInstallation(1);
      for (const id of [1, 2, 3]) store(id, 1, { syncState: "ready" });
      listing[1] = [{ id: 4, owner: "acme", name: "kept" }];
      secondListing(() =>
        HttpResponse.json({
          total_count: 2,
          repositories: [entry(2), entry(4)],
        }),
      );
      const { discovery } = build();
      await discovery.discover(1);
      expect(
        allRepos()
          .map((row) => row.id)
          .sort(),
      ).toEqual(["R_2", "R_4"]);
    });

    it("is purged by the discovery an access computation queues for the repo it re-created", async () => {
      addInstallation(1);
      const { discovery, logger } = build();
      const jobs = createJobs({ logger });
      registerDiscoveryJob(jobs, discovery, logger);
      listing[1] = [];
      // what a computation in flight stores after a purge: the repo, pending,
      // with access, although GitHub no longer lists it
      store(1, 1);
      const alice = addUser(database.db, "alice");
      database.db
        .insert(schema.userRepoAccess)
        .values({ userId: alice.id, repoId: "R_1", computedAt: 1 })
        .run();
      jobs.start();
      expect(enqueueDiscovery(jobs, 1)).toBe(true);
      await jobs.stop();
      expect(allRepos()).toEqual([]);
      expect(count(schema.userRepoAccess)).toBe(0);
    });
  });

  it("does not log an installation token", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 1 }];
    const { discovery } = build();
    await discovery.discover(1);
    expect(JSON.stringify(logs)).not.toContain("ghs_fake_for_");
  });
});

describe("the discovery job", () => {
  it("runs discovery for the enqueued installation and drops a duplicate while one is pending", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 1 }];
    const { discovery, logger } = build();
    const jobs = createJobs({ logger });
    registerDiscoveryJob(jobs, discovery, logger);
    expect(enqueueDiscovery(jobs, 1)).toBe(true);
    expect(enqueueDiscovery(jobs, 1)).toBe(false);
    jobs.start();
    await jobs.stop();
    expect(repoRow(1)).toMatchObject({ syncState: "pending" });
    expect(DISCOVERY_JOB).toBe("sync.discover");
  });
});

describe("the scheduled discovery", () => {
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("is scheduled every 24 hours through the jobs interface", () => {
    const { logger } = build();
    const jobs = createJobs({ logger });
    registerDiscoverySchedule(jobs, database.db, () => true);
    expect(DISCOVERY_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(() => jobs.schedule(DISCOVERY_SCHEDULE_JOB, 1000)).toThrow(
      /already scheduled/,
    );
  });

  it("discovers every active, non-suspended installation and no other", async () => {
    addInstallation(1);
    addInstallation(2, true);
    addInstallation(3);
    active.delete(3);
    addInstallation(4);
    for (const id of [1, 2, 3, 4]) {
      listing[id] = [{ id, owner: `acct-${String(id)}`, name: "r" }];
    }
    const { discovery, logger } = build();
    const jobs = createJobs({ logger });
    registerDiscoveryJob(jobs, discovery, logger);
    registerDiscoverySchedule(jobs, database.db, (id) => active.has(id));
    jobs.start();
    expect(jobs.enqueue(DISCOVERY_SCHEDULE_JOB, undefined)).toBe(true);
    await until(() => allRepos().length === 2);
    await jobs.stop();
    expect(allRepos().map((row) => row.installationId)).toEqual([1, 4]);
    expect(listRequests.map((request) => request.installation).sort()).toEqual([
      1, 4,
    ]);
  });

  it("discovers an installation at the next scheduled run after a listing answered 502, and logs the failure with the installation id", async () => {
    addInstallation(1);
    listing[1] = [{ id: 1, owner: "acme", name: "r", openIssues: 1 }];
    let failing = true;
    const attempts: number[] = [];
    fake.server.use(
      http.get(`${FAKE_API_URL}/installation/repositories`, () => {
        if (!failing) return undefined;
        attempts.push(1);
        return HttpResponse.json({ message: "bad gateway" }, { status: 502 });
      }),
    );
    const { discovery, logger } = build();
    const jobs = createJobs({ logger });
    registerDiscoveryJob(jobs, discovery, logger);
    registerDiscoverySchedule(jobs, database.db, (id) => active.has(id), 30);
    jobs.start();
    try {
      const failures = () =>
        logs.filter(
          (record) =>
            record.level === 40 &&
            String(record.msg).startsWith("repository discovery failed"),
        );
      await until(() => failures().length > 0);
      expect(failures()[0]).toMatchObject({ installationId: 1 });
      // the first run is the original request and the client's three retries
      expect(attempts.length).toBeGreaterThanOrEqual(4);
      expect(allRepos()).toEqual([]);

      failing = false;
      await until(() => allRepos().length > 0);
      expect(repoRow(1)).toMatchObject({
        syncState: "pending",
        installationId: 1,
      });
      expect(queued.at(-1)).toEqual([{ id: "R_1", installationId: 1 }]);
    } finally {
      await jobs.stop();
    }
  });
});
