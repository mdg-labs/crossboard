import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueDetailsSchema } from "../src/api/schemas.js";
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import {
  GithubError,
  createGithubClient,
  type InstallationClient,
} from "../src/github/index.js";
import { DETAILS_MAX_AGE_MS } from "../src/issues/index.js";
import { createLogger } from "../src/logger.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { githubEnv, validEnv } from "./helpers.js";
import { addUser, createTestAccess, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-details-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
  addInstallation(1, false);
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function addInstallation(id: number, suspended: boolean) {
  database.db
    .insert(schema.installations)
    .values({
      id,
      accountLogin: `acme${String(id)}`,
      accountId: id,
      accountType: "Organization",
      suspended,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

type Budget = {
  remaining: number;
  limit: number | null;
  resetAt: number | null;
};

interface Call {
  installationId: number;
  query: { name: string; document: string };
  variables: Record<string, unknown> | undefined;
  repo: string | undefined;
}

/** An installation client that answers from `respond` and records each call. */
function fakeInstallations() {
  const calls: Call[] = [];
  const state: {
    budget: Budget | null;
    respond: (call: Call) => Promise<unknown>;
  } = {
    budget: null,
    respond: () => Promise.resolve(answer()),
  };
  const client: Pick<InstallationClient, "budgets" | "graphql"> = {
    budgets: {
      get: () => ({ rest: null, graphql: state.budget }),
    },
    graphql(installationId, query, variables, context) {
      const call: Call = {
        installationId,
        query,
        variables,
        repo: context?.repo,
      };
      calls.push(call);
      return state.respond(call);
    },
  };
  return { client, calls, state };
}

const comment = (n: number, bodyHTML = `<p>comment ${String(n)}</p>`) => ({
  url: `https://github.com/acme/web/issues/1#issuecomment-${String(n)}`,
  createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
  author: { login: `user${String(n)}`, avatarUrl: `https://a/${String(n)}` },
  bodyHTML,
});

const subIssue = (number: number, repo = "acme/web") => ({
  id: `I_sub${String(number)}`,
  number,
  title: `Sub ${String(number)}`,
  state: "OPEN",
  url: `https://github.com/${repo}/issues/${String(number)}`,
  repository: { nameWithOwner: repo },
});

function answer(overrides: Record<string, unknown> = {}) {
  return {
    rateLimit: { cost: 1, remaining: 4900, limit: 5000, resetAt: null },
    node: {
      bodyHTML: "<p>the body</p>",
      comments: { totalCount: 1, nodes: [comment(1)] },
      subIssues: { totalCount: 1, nodes: [subIssue(7)] },
      ...overrides,
    },
  };
}

function build(client: Pick<InstallationClient, "budgets" | "graphql">) {
  const logger = createLogger("silent");
  const config = loadConfig({
    ...validEnv,
    ...githubEnv,
    CROSSBOARD_ALLOWED_USERS: "octocat",
  });
  const github = createGithubClient({
    apiUrl: config.githubApiUrl,
    webUrl: config.githubWebUrl,
    logger,
  });
  const setup = createSetup({ db: database.db, config, logger });
  return createApp({
    logger,
    db: database.db,
    github,
    version: "1.0.0",
    webRoot: join(dir, "dist"),
    setup,
    access: createTestAccess({
      db: database.db,
      github,
      setup,
      appSecret: config.appSecret,
      logger,
    }),
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
    installations: client,
  });
}

let nextRepo = 1;

function addRepo(
  owner: string,
  name: string,
  userIds: number[],
  installationId = 1,
): string {
  const id = `R_${String(nextRepo)}`;
  database.db
    .insert(schema.repos)
    .values({
      id,
      databaseId: nextRepo++,
      installationId,
      owner,
      name,
      private: true,
      syncState: "ready",
      openIssueCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  for (const userId of userIds) {
    database.db
      .insert(schema.userRepoAccess)
      .values({ userId, repoId: id, computedAt: 1 })
      .run();
  }
  return id;
}

let nextIssue = 1;

function addIssue(repoId: string, number: number, updatedAt = 1000): string {
  const id = `I_${String(nextIssue++)}`;
  database.db
    .insert(schema.issues)
    .values({
      id,
      databaseId: nextIssue,
      repoId,
      number,
      title: `Issue ${String(number)}`,
      url: `https://github.com/acme/web/issues/${String(number)}`,
      authorLogin: "alice",
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
      updatedAt,
      syncedAt: 1,
    })
    .run();
  return id;
}

/** Links the allowed user `octocat` to installation 1, which makes it active (SPEC FR-3). */
function activate(userId: number, installationId = 1) {
  database.db
    .insert(schema.userInstallations)
    .values({ userId, installationId, computedAt: 1 })
    .run();
}

function seedCache(
  issueId: string,
  options: { fetchedForUpdatedAt?: number; fetchedAt?: number } = {},
) {
  database.db
    .insert(schema.issueDetails)
    .values({
      issueId,
      bodyHtml: "<p>cached body</p>",
      commentsJson: JSON.stringify([]),
      commentsTotal: 0,
      subIssuesJson: JSON.stringify({ total: 0, items: [] }),
      fetchedForUpdatedAt: options.fetchedForUpdatedAt ?? 1000,
      fetchedAt: options.fetchedAt ?? Date.now(),
    })
    .run();
}

const cachedRow = (issueId: string) =>
  database.db
    .select()
    .from(schema.issueDetails)
    .all()
    .find((row) => row.issueId === issueId);

function details(
  app: ReturnType<typeof build>,
  cookie: string,
  path = "/acme/web/1",
) {
  return app.request(`/api/issues${path}/details`, {
    headers: { Cookie: cookie },
  });
}

/** One synced issue acme/web#1 that `octocat` reads, with the installation active. */
function setupOne() {
  const alice = addUser(database.db, "octocat");
  activate(alice.id);
  const repo = addRepo("acme", "web", [alice.id]);
  const issueId = addIssue(repo, 1);
  return { alice, repo, issueId, cookie: signIn(database.db, alice.id).cookie };
}

describe("GET /api/issues/:owner/:repo/:number/details", () => {
  it("rejects a request without a session", async () => {
    const fake = fakeInstallations();
    setupOne();
    const response = await build(fake.client).request(
      "/api/issues/acme/web/1/details",
    );
    expect(response.status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("answers 404 and sends no GitHub call for an issue the user cannot read", async () => {
    const fake = fakeInstallations();
    const { alice, repo } = setupOne();
    const bob = addUser(database.db, "bob");
    addIssue(addRepo("acme", "other", [alice.id]), 3);
    const app = build(fake.client);
    const bobCookie = signIn(database.db, bob.id).cookie;

    expect((await details(app, bobCookie)).status).toBe(404);
    expect((await details(app, bobCookie, "/acme/WEB/1")).status).toBe(404);
    expect((await details(app, bobCookie, "/acme/other/3")).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
    expect(database.db.select().from(schema.issueDetails).all()).toEqual([]);

    database.db
      .insert(schema.userRepoAccess)
      .values({ userId: bob.id, repoId: repo, computedAt: 1 })
      .run();
    expect((await details(app, bobCookie)).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("does not hand another user's cached copy to a user without access", async () => {
    const fake = fakeInstallations();
    const { issueId } = setupOne();
    seedCache(issueId);
    const bob = addUser(database.db, "bob");

    const response = await details(
      build(fake.client),
      signIn(database.db, bob.id).cookie,
    );

    expect(response.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("answers 404 for an issue that is not synced", async () => {
    const fake = fakeInstallations();
    const { cookie } = setupOne();
    const response = await details(build(fake.client), cookie, "/acme/web/99");
    expect(response.status).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });

  it("fetches body, comments and sub-issues with the repo's installation", async () => {
    const fake = fakeInstallations();
    const { cookie, issueId } = setupOne();

    const response = await details(build(fake.client), cookie);

    expect(response.status).toBe(200);
    const [call] = fake.calls;
    expect(fake.calls).toHaveLength(1);
    expect(call?.installationId).toBe(1);
    expect(call?.variables).toEqual({ id: issueId });
    expect(call?.repo).toBe("acme/web");
    const document = call?.query.document ?? "";
    expect(document).toContain("bodyHTML");
    expect(document).toContain("comments(last: 100)");
    expect(document).toMatch(
      /comments\(last: 100\)[\s\S]*author \{ login avatarUrl \}[\s\S]*createdAt|createdAt[\s\S]*author \{ login avatarUrl \}/,
    );
    expect(document).toContain("subIssues(first: 50)");
    expect(document).toContain("repository { nameWithOwner }");
    for (const field of ["url", "state", "totalCount"]) {
      expect(document).toContain(field);
    }
    const body = issueDetailsSchema.parse(await response.json());
    expect(body).toEqual({
      bodyHtml: "<p>the body</p>",
      comments: [
        {
          url: "https://github.com/acme/web/issues/1#issuecomment-1",
          createdAt: Date.UTC(2026, 0, 1),
          author: "user1",
          avatarUrl: "https://a/1",
          bodyHtml: "<p>comment 1</p>",
        },
      ],
      commentsTotal: 1,
      subIssues: {
        total: 1,
        notAccessible: 0,
        items: [
          {
            owner: "acme",
            repo: "web",
            number: 7,
            title: "Sub 7",
            state: "OPEN",
            url: "https://github.com/acme/web/issues/7",
          },
        ],
      },
      fetchedAt: expect.any(Number) as number,
      stale: false,
    });
  });

  it("carries the comment and sub-issue totals beyond what is listed", async () => {
    const fake = fakeInstallations();
    fake.state.respond = () =>
      Promise.resolve(
        answer({
          comments: { totalCount: 130, nodes: [comment(1), comment(2)] },
          subIssues: { totalCount: 60, nodes: [subIssue(7)] },
        }),
      );
    const { cookie } = setupOne();

    const body = issueDetailsSchema.parse(
      await (await details(build(fake.client), cookie)).json(),
    );

    expect(body.commentsTotal).toBe(130);
    expect(body.comments).toHaveLength(2);
    expect(body.subIssues.total).toBe(60);
    expect(body.subIssues.items).toHaveLength(1);
  });

  it("shows a deleted comment author as ghost", async () => {
    const fake = fakeInstallations();
    fake.state.respond = () =>
      Promise.resolve(
        answer({
          comments: {
            totalCount: 1,
            nodes: [{ ...comment(1), author: null }],
          },
        }),
      );
    const { cookie } = setupOne();

    const body = issueDetailsSchema.parse(
      await (await details(build(fake.client), cookie)).json(),
    );

    expect(body.comments[0]?.author).toBe("ghost");
    expect(body.comments[0]?.avatarUrl).toBeNull();
  });

  it("sanitizes the body and every comment before storing and sending them", async () => {
    const fake = fakeInstallations();
    fake.state.respond = () =>
      Promise.resolve(
        answer({
          bodyHTML:
            '<p onclick="x()">body</p><script>alert(1)</script><img src="https://e.com/a.png" onerror="alert(2)">',
          comments: {
            totalCount: 1,
            nodes: [
              comment(
                1,
                '<a href="javascript:alert(3)">c</a><iframe src="https://evil.example"></iframe>',
              ),
            ],
          },
        }),
      );
    const { cookie, issueId } = setupOne();

    const response = await details(build(fake.client), cookie);
    const text = await response.text();

    for (const dirty of [
      "<script",
      "onclick",
      "onerror",
      "javascript:",
      "<iframe",
    ]) {
      expect(text).not.toContain(dirty);
    }
    const stored = cachedRow(issueId);
    expect(stored?.bodyHtml).toBe(
      '<p>body</p><img src="https://e.com/a.png" />',
    );
    const storedComments = stored?.commentsJson ?? "";
    for (const dirty of ["javascript:", "<iframe"]) {
      expect(storedComments).not.toContain(dirty);
    }
  });

  it("serves a fresh copy without a GitHub call", async () => {
    const fake = fakeInstallations();
    const { cookie } = setupOne();
    const app = build(fake.client);

    await details(app, cookie);
    const again = await details(app, cookie);

    expect(again.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("refetches when the issue changed since the copy was fetched", async () => {
    const fake = fakeInstallations();
    const { cookie, issueId } = setupOne();
    seedCache(issueId, { fetchedForUpdatedAt: 999 });

    const body = issueDetailsSchema.parse(
      await (await details(build(fake.client), cookie)).json(),
    );

    expect(fake.calls).toHaveLength(1);
    expect(body.bodyHtml).toBe("<p>the body</p>");
    expect(body.stale).toBe(false);
    expect(cachedRow(issueId)?.fetchedForUpdatedAt).toBe(1000);
  });

  it("refetches a copy older than ten minutes and keeps one younger", async () => {
    const fake = fakeInstallations();
    const { cookie, issueId } = setupOne();
    const app = build(fake.client);

    seedCache(issueId, { fetchedAt: Date.now() - DETAILS_MAX_AGE_MS + 60_000 });
    await details(app, cookie);
    expect(fake.calls).toHaveLength(0);

    database.db.delete(schema.issueDetails).run();
    seedCache(issueId, { fetchedAt: Date.now() - DETAILS_MAX_AGE_MS - 1000 });
    await details(app, cookie);
    expect(fake.calls).toHaveLength(1);
  });

  it("shares one fetch between concurrent requests for an issue", async () => {
    const fake = fakeInstallations();
    let release: (value: unknown) => void = () => undefined;
    fake.state.respond = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { alice, repo, cookie } = setupOne();
    const bob = addUser(database.db, "bob");
    database.db
      .insert(schema.userRepoAccess)
      .values({ userId: bob.id, repoId: repo, computedAt: 1 })
      .run();
    const app = build(fake.client);
    const bobCookie = signIn(database.db, bob.id).cookie;

    const responses = [
      details(app, cookie),
      details(app, cookie),
      details(app, bobCookie),
    ];
    await new Promise((resolve) => setTimeout(resolve, 50));
    release(answer());
    const done = await Promise.all(responses);

    expect(done.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(fake.calls).toHaveLength(1);
    expect(alice.id).not.toBe(bob.id);
  });

  it("starts a new fetch once the shared one has finished", async () => {
    const fake = fakeInstallations();
    const { cookie, issueId } = setupOne();
    const app = build(fake.client);

    await details(app, cookie);
    database.db
      .update(schema.issueDetails)
      .set({ fetchedAt: Date.now() - DETAILS_MAX_AGE_MS - 1000 })
      .run();
    await details(app, cookie);

    expect(fake.calls).toHaveLength(2);
    expect(cachedRow(issueId)).toBeDefined();
  });

  describe("when the fetch fails", () => {
    it("returns the stale copy with stale: true", async () => {
      const fake = fakeInstallations();
      fake.state.respond = () =>
        Promise.reject(new GithubError(502, "Bad Gateway"));
      const { cookie, issueId } = setupOne();
      seedCache(issueId, { fetchedForUpdatedAt: 5 });

      const response = await details(build(fake.client), cookie);

      expect(response.status).toBe(200);
      const body = issueDetailsSchema.parse(await response.json());
      expect(body.stale).toBe(true);
      expect(body.bodyHtml).toBe("<p>cached body</p>");
      expect(cachedRow(issueId)?.fetchedForUpdatedAt).toBe(5);
    });

    it("answers 502 when GitHub fails and there is no copy", async () => {
      const fake = fakeInstallations();
      fake.state.respond = () =>
        Promise.reject(new GithubError(502, "Bad Gateway"));
      const { cookie, issueId } = setupOne();

      const response = await details(build(fake.client), cookie);

      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("github_error");
      expect(cachedRow(issueId)).toBeUndefined();
    });

    it("answers 502 when GitHub no longer returns the issue", async () => {
      const fake = fakeInstallations();
      fake.state.respond = () =>
        Promise.resolve({ rateLimit: { cost: 1 }, node: null });
      const { cookie } = setupOne();

      expect((await details(build(fake.client), cookie)).status).toBe(502);
    });

    it("answers 502 for an answer that is not an issue", async () => {
      const fake = fakeInstallations();
      fake.state.respond = () => Promise.resolve({ node: {} });
      const { cookie } = setupOne();

      expect((await details(build(fake.client), cookie)).status).toBe(502);
    });

    it("answers 503 with the reset time when the budget is below 2%, without calling GitHub", async () => {
      const fake = fakeInstallations();
      const resetAt = Date.now() + 30 * 60 * 1000;
      fake.state.budget = { remaining: 99, limit: 5000, resetAt };
      const { cookie, issueId } = setupOne();

      const response = await details(build(fake.client), cookie);

      expect(response.status).toBe(503);
      const body = (await response.json()) as {
        error: { code: string; resetAt: number | null };
      };
      expect(body.error.code).toBe("github_rate_limited");
      expect(body.error.resetAt).toBe(resetAt);
      expect(fake.calls).toHaveLength(0);
      expect(cachedRow(issueId)).toBeUndefined();
    });

    it("fetches at exactly 2% remaining", async () => {
      const fake = fakeInstallations();
      fake.state.budget = {
        remaining: 100,
        limit: 5000,
        resetAt: Date.now() + 60_000,
      };
      const { cookie } = setupOne();

      expect((await details(build(fake.client), cookie)).status).toBe(200);
    });

    it("fetches when the reported budget has already reset", async () => {
      const fake = fakeInstallations();
      fake.state.budget = {
        remaining: 0,
        limit: 5000,
        resetAt: Date.now() - 1000,
      };
      const { cookie } = setupOne();

      expect((await details(build(fake.client), cookie)).status).toBe(200);
    });

    it("answers 503 for a budget of zero whose limit is unknown", async () => {
      const fake = fakeInstallations();
      fake.state.budget = {
        remaining: 0,
        limit: null,
        resetAt: Date.now() + 60_000,
      };
      const { cookie } = setupOne();

      expect((await details(build(fake.client), cookie)).status).toBe(503);
      expect(fake.calls).toHaveLength(0);
    });

    it("answers 503 when GitHub reports the limit as spent", async () => {
      const fake = fakeInstallations();
      fake.state.respond = () =>
        Promise.reject(new GithubError(502, "API rate limit", "RATE_LIMITED"));
      const { cookie } = setupOne();

      const response = await details(build(fake.client), cookie);

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("github_rate_limited");
    });

    it("returns the stale copy instead of 503 when the budget is spent", async () => {
      const fake = fakeInstallations();
      fake.state.budget = {
        remaining: 0,
        limit: 5000,
        resetAt: Date.now() + 60_000,
      };
      const { cookie, issueId } = setupOne();
      seedCache(issueId, { fetchedAt: Date.now() - DETAILS_MAX_AGE_MS - 1000 });

      const response = await details(build(fake.client), cookie);

      expect(response.status).toBe(200);
      expect(issueDetailsSchema.parse(await response.json()).stale).toBe(true);
      expect(fake.calls).toHaveLength(0);
    });

    it("answers 503 for a suspended installation, without calling GitHub", async () => {
      const fake = fakeInstallations();
      const { cookie } = setupOne();
      database.db.update(schema.installations).set({ suspended: true }).run();

      const response = await details(build(fake.client), cookie);

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("installation_unavailable");
      expect(fake.calls).toHaveLength(0);
    });

    it("answers 503 for an installation that is not active", async () => {
      const fake = fakeInstallations();
      const alice = addUser(database.db, "octocat");
      addIssue(addRepo("acme", "web", [alice.id]), 1);

      const response = await details(
        build(fake.client),
        signIn(database.db, alice.id).cookie,
      );

      expect(response.status).toBe(503);
      expect(fake.calls).toHaveLength(0);
    });
  });

  it("answers 404 and stores nothing when the issue is removed during the fetch", async () => {
    const fake = fakeInstallations();
    const { cookie, issueId } = setupOne();
    fake.state.respond = () => {
      database.db.delete(schema.issues).run();
      return Promise.resolve(answer());
    };

    const response = await details(build(fake.client), cookie);

    expect(response.status).toBe(404);
    expect(cachedRow(issueId)).toBeUndefined();
  });

  it("leaves sub-issues of repos outside the user's access out of the answer", async () => {
    const fake = fakeInstallations();
    fake.state.respond = () =>
      Promise.resolve(
        answer({
          subIssues: {
            totalCount: 3,
            nodes: [
              subIssue(7),
              subIssue(8, "acme/secret"),
              subIssue(9, "ACME/Web"),
            ],
          },
        }),
      );
    const { alice, cookie } = setupOne();
    const app = build(fake.client);
    addRepo("acme", "secret", []);

    const forAlice = issueDetailsSchema.parse(
      await (await details(app, cookie)).json(),
    );
    expect(forAlice.subIssues.items.map((sub) => sub.number)).toEqual([7, 9]);
    expect(forAlice.subIssues.notAccessible).toBe(1);
    expect(forAlice.subIssues.total).toBe(3);
    expect(JSON.stringify(forAlice)).not.toContain("secret");

    const secretId = database.db
      .select()
      .from(schema.repos)
      .all()
      .find((repo) => repo.name === "secret")?.id;
    database.db
      .insert(schema.userRepoAccess)
      .values({ userId: alice.id, repoId: secretId ?? "", computedAt: 1 })
      .run();
    const withAccess = issueDetailsSchema.parse(
      await (await details(app, cookie)).json(),
    );
    expect(withAccess.subIssues.items.map((sub) => sub.number)).toEqual([
      7, 8, 9,
    ]);
    expect(withAccess.subIssues.notAccessible).toBe(0);
  });
});
