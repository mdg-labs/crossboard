import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  issueListSchema,
  issueSummarySchema,
  type IssueList,
} from "../src/api/schemas.js";
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  githubEnv,
  validEnv,
  unusedInstallations,
  unusedJobs,
} from "./helpers.js";
import { addUser, createTestAccess, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-issues-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
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
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build() {
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
    installations: unusedInstallations,
    jobs: unusedJobs,
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
  });
}

let nextRepo = 1;

function addRepo(owner: string, name: string, userIds: number[]): string {
  const id = `R_${String(nextRepo)}`;
  database.db
    .insert(schema.repos)
    .values({
      id,
      databaseId: nextRepo++,
      installationId: 1,
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

interface IssueSeed {
  id?: string;
  number: number;
  title?: string;
  authorLogin?: string | null;
  typeName?: string | null;
  parentId?: string | null;
  blockedByTotal?: number;
  blockingTotal?: number;
  createdAt?: number;
  updatedAt?: number;
}

let nextIssue = 1;

function issueRow(repoId: string, seed: IssueSeed) {
  const id = seed.id ?? `I_${String(nextIssue++)}`;
  return {
    id,
    databaseId: nextIssue,
    repoId,
    number: seed.number,
    title: seed.title ?? `Issue ${String(seed.number)}`,
    url: `https://github.com/x/y/issues/${String(seed.number)}`,
    authorLogin: seed.authorLogin === undefined ? "alice" : seed.authorLogin,
    typeName: seed.typeName ?? null,
    typeColor: seed.typeName ? "RED" : null,
    milestoneTitle: null,
    milestoneUrl: null,
    parentId: seed.parentId ?? null,
    subTotal: 0,
    subCompleted: 0,
    blockedByTotal: seed.blockedByTotal ?? 0,
    blockingTotal: seed.blockingTotal ?? 0,
    createdAt: seed.createdAt ?? 1000,
    updatedAt: seed.updatedAt ?? 1000,
    syncedAt: 1,
  };
}

function addIssue(repoId: string, seed: IssueSeed): string {
  const row = issueRow(repoId, seed);
  database.db.insert(schema.issues).values(row).run();
  return row.id;
}

function addRef(
  id: string,
  repoFullName: string,
  number: number,
  state: "OPEN" | "CLOSED",
) {
  database.db
    .insert(schema.issueRefs)
    .values({
      id,
      repoFullName,
      number,
      title: `Ref ${String(number)}`,
      state,
      url: `https://github.com/${repoFullName}/issues/${String(number)}`,
      seenAt: 1,
    })
    .run();
}

function addDep(blockedId: string, blockingId: string) {
  database.db.insert(schema.issueDeps).values({ blockedId, blockingId }).run();
}

async function list(cookie: string, query = ""): Promise<Response> {
  return build().request(`/api/issues${query}`, {
    headers: { Cookie: cookie },
  });
}

async function listBody(cookie: string, query = ""): Promise<IssueList> {
  const response = await list(cookie, query);
  expect(response.status).toBe(200);
  return issueListSchema.parse(await response.json());
}

const numbers = (body: IssueList) => body.items.map((item) => item.number);

describe("GET /api/issues", () => {
  it("rejects a request without a session", async () => {
    const response = await build().request("/api/issues");
    expect(response.status).toBe(401);
  });

  it("returns the issue item of SPEC §7.4 for the user's repos, newest update first", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    const id = addIssue(repo, {
      number: 1,
      title: "Older",
      updatedAt: 1000,
      typeName: "Bug",
    });
    addIssue(repo, { number: 2, title: "Newer", updatedAt: 2000 });
    database.db
      .insert(schema.labels)
      .values([
        {
          id: "L_1",
          repoId: repo,
          name: "bug",
          color: "d73a4a",
          description: null,
        },
        {
          id: "L_2",
          repoId: repo,
          name: "ui",
          color: "0075ca",
          description: null,
        },
      ])
      .run();
    database.db
      .insert(schema.issueLabels)
      .values([
        { issueId: id, labelId: "L_2" },
        { issueId: id, labelId: "L_1" },
      ])
      .run();
    database.db
      .insert(schema.issueAssignees)
      .values({ issueId: id, login: "bob", avatarUrl: "https://a/bob" })
      .run();

    const body = await listBody(signIn(database.db, alice.id).cookie);

    expect(body.total).toBe(2);
    expect(body.warnings).toEqual([]);
    expect(numbers(body)).toEqual([2, 1]);
    expect(body.items[1]).toEqual({
      id,
      repo: { owner: "acme", name: "web" },
      number: 1,
      title: "Older",
      url: "https://github.com/x/y/issues/1",
      author: "alice",
      type: { name: "Bug", color: "RED" },
      milestone: null,
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "ui", color: "0075ca" },
      ],
      assignees: [{ login: "bob", avatarUrl: "https://a/bob" }],
      parent: null,
      subIssues: { total: 0, completed: 0 },
      blockedBy: { open: 0, notAccessible: 0 },
      blocking: { open: 0, notAccessible: 0 },
      isBlocked: false,
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it("treats an empty or blank q as is:open", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    addIssue(repo, { number: 1 });
    const { cookie } = signIn(database.db, alice.id);

    expect((await listBody(cookie, "?q=")).total).toBe(1);
    expect((await listBody(cookie, "?q=%20%20")).total).toBe(1);
    expect((await listBody(cookie, "?q=is%3Aopen")).total).toBe(1);
  });

  it("evaluates the filter with the session user as viewer and maps a missing author to ghost", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    addIssue(repo, { number: 1, authorLogin: "octocat" });
    addIssue(repo, { number: 2, authorLogin: null });
    addIssue(repo, { number: 3, authorLogin: "alice" });
    const { cookie } = signIn(database.db, alice.id);

    expect(numbers(await listBody(cookie, "?q=author%3A%40me"))).toEqual([1]);
    const ghosts = await listBody(cookie, "?q=author%3Aghost");
    expect(numbers(ghosts)).toEqual([2]);
    expect(ghosts.items[0]?.author).toBe("ghost");
  });

  it("sorts by every option and breaks ties by repo then number", async () => {
    const alice = addUser(database.db, "octocat");
    const zeta = addRepo("acme", "zeta", [alice.id]);
    const alpha = addRepo("acme", "alpha", [alice.id]);
    addIssue(zeta, {
      number: 1,
      title: "banana",
      createdAt: 10,
      updatedAt: 40,
    });
    addIssue(alpha, {
      number: 2,
      title: "Cherry",
      createdAt: 30,
      updatedAt: 20,
    });
    addIssue(alpha, {
      number: 1,
      title: "apple",
      createdAt: 20,
      updatedAt: 30,
    });
    const { cookie } = signIn(database.db, alice.id);
    const order = async (sort: string) =>
      (await listBody(cookie, `?sort=${sort}`)).items.map(
        (item) => `${item.repo.name}#${String(item.number)}`,
      );

    expect(await order("updated-desc")).toEqual([
      "zeta#1",
      "alpha#1",
      "alpha#2",
    ]);
    expect(await order("updated-asc")).toEqual([
      "alpha#2",
      "alpha#1",
      "zeta#1",
    ]);
    expect(await order("created-desc")).toEqual([
      "alpha#2",
      "alpha#1",
      "zeta#1",
    ]);
    expect(await order("created-asc")).toEqual([
      "zeta#1",
      "alpha#1",
      "alpha#2",
    ]);
    expect(await order("repo-asc")).toEqual(["alpha#1", "alpha#2", "zeta#1"]);
    expect(await order("title-asc")).toEqual(["alpha#1", "zeta#1", "alpha#2"]);
  });

  it("pages with offset and limit, and reports the unpaged total", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    for (let number = 1; number <= 5; number++) {
      addIssue(repo, { number, updatedAt: 1000 + number });
    }
    const { cookie } = signIn(database.db, alice.id);

    const page = await listBody(cookie, "?limit=2&offset=1");
    expect(numbers(page)).toEqual([4, 3]);
    expect(page.total).toBe(5);
    expect(numbers(await listBody(cookie, "?limit=2&offset=4"))).toEqual([1]);
    expect(numbers(await listBody(cookie, "?offset=9"))).toEqual([]);
  });

  it("defaults the limit to 100", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    database.db
      .insert(schema.issues)
      .values(
        Array.from({ length: 150 }, (_, index) =>
          issueRow(repo, { number: index + 1 }),
        ),
      )
      .run();

    const body = await listBody(signIn(database.db, alice.id).cookie);
    expect(body.items).toHaveLength(100);
    expect(body.total).toBe(150);
  });

  it.each([
    "?limit=201",
    "?limit=0",
    "?limit=abc",
    "?offset=-1",
    "?sort=random",
  ])("answers 400 for %s", async (query) => {
    const alice = addUser(database.db, "octocat");
    const response = await list(signIn(database.db, alice.id).cookie, query);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("answers 400 with the parse error and its range for an invalid filter", async () => {
    const alice = addUser(database.db, "octocat");
    const { cookie } = signIn(database.db, alice.id);

    const response = await list(cookie, "?q=%28label%3Abug");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_query",
        message: expect.any(String) as string,
        start: 0,
        end: 1,
      },
    });
  });

  it("returns warnings with the result and ignores the unknown qualifier", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    addIssue(repo, { number: 1 });
    const { cookie } = signIn(database.db, alice.id);

    const body = await listBody(cookie, "?q=color%3Ared");

    expect(body.total).toBe(1);
    expect(body.warnings).toEqual([
      { message: expect.any(String) as string, start: 0, end: 9 },
    ]);
  });

  it("counts readable open relations and the not accessible rest, and flags blocked issues", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    const blocked = addIssue(repo, {
      number: 1,
      blockedByTotal: 4,
      blockingTotal: 1,
    });
    const free = addIssue(repo, { number: 2, blockedByTotal: 1 });
    addIssue(repo, { number: 3 });
    addRef("I_open", "acme/web", 10, "OPEN");
    addRef("I_closed", "acme/web", 11, "CLOSED");
    addRef("I_dep", "acme/web", 12, "OPEN");
    addDep(blocked, "I_open");
    addDep(blocked, "I_closed");
    addDep("I_dep", blocked);
    addDep(free, "I_closed");
    const { cookie } = signIn(database.db, alice.id);

    const body = await listBody(cookie);
    const byNumber = (number: number) =>
      body.items.find((item) => item.number === number);

    expect(byNumber(1)).toMatchObject({
      blockedBy: { open: 1, notAccessible: 2 },
      blocking: { open: 1, notAccessible: 0 },
      isBlocked: true,
    });
    expect(byNumber(2)).toMatchObject({
      blockedBy: { open: 0, notAccessible: 0 },
      isBlocked: false,
    });
    expect(byNumber(3)).toMatchObject({ isBlocked: false });
    expect(numbers(await listBody(cookie, "?q=is%3Ablocked"))).toEqual([1]);
    expect(
      numbers(await listBody(cookie, "?q=blocked-by%3Aacme%2Fweb%2311")),
    ).toEqual([1, 2]);
  });

  it("returns the parent of an issue", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo("acme", "web", [alice.id]);
    addRef("I_parent", "acme/api", 7, "OPEN");
    addRepo("acme", "api", [alice.id]);
    addIssue(repo, { number: 1, parentId: "I_parent" });

    const body = await listBody(signIn(database.db, alice.id).cookie);

    expect(body.items[0]?.parent).toEqual({
      owner: "acme",
      repo: "api",
      number: 7,
    });
    expect(
      numbers(
        await listBody(
          signIn(database.db, alice.id).cookie,
          "?q=parent%3Aacme%2Fapi%237",
        ),
      ),
    ).toEqual([1]);
  });
});

describe("GET /api/issues isolation", () => {
  it("never returns a repo or issue the session user lacks access to", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bob");
    const shared = addRepo("acme", "shared", [alice.id, bob.id]);
    const secret = addRepo("acme", "secret", [alice.id]);
    addIssue(shared, { number: 1, title: "visible to both" });
    addIssue(secret, { number: 2, title: "only for alice" });
    const asAlice = signIn(database.db, alice.id).cookie;
    const asBob = signIn(database.db, bob.id).cookie;

    const forAlice = await listBody(asAlice);
    const forBob = await listBody(asBob);

    expect(numbers(forAlice).sort()).toEqual([1, 2]);
    expect(numbers(forBob)).toEqual([1]);
    expect(forBob.total).toBe(1);
    const raw = await (await list(asBob)).text();
    expect(raw).not.toContain("only for alice");
    expect(raw).not.toContain("secret");
    expect((await listBody(asBob, "?q=repo%3Aacme%2Fsecret")).total).toBe(0);
    expect((await listBody(asBob, "?q=only")).total).toBe(0);
  });

  it("does not name a parent or a dependency in a repo outside the user's access", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bob");
    const shared = addRepo("acme", "shared", [alice.id, bob.id]);
    addRepo("acme", "secret", [alice.id]);
    addRef("I_secret_parent", "acme/secret", 5, "OPEN");
    addRef("I_secret_blocker", "acme/secret", 6, "OPEN");
    addRef("I_shared_blocker", "acme/shared", 7, "OPEN");
    const issue = addIssue(shared, {
      number: 1,
      parentId: "I_secret_parent",
      blockedByTotal: 2,
    });
    addDep(issue, "I_secret_blocker");
    addDep(issue, "I_shared_blocker");

    const forAlice = (await listBody(signIn(database.db, alice.id).cookie))
      .items[0];
    const asBob = signIn(database.db, bob.id).cookie;
    const forBob = (await listBody(asBob)).items[0];

    expect(forAlice?.parent).toEqual({
      owner: "acme",
      repo: "secret",
      number: 5,
    });
    expect(forAlice?.blockedBy).toEqual({ open: 2, notAccessible: 0 });
    expect(forBob?.parent).toBeNull();
    expect(forBob?.blockedBy).toEqual({ open: 1, notAccessible: 1 });
    expect(forBob?.isBlocked).toBe(true);
    expect(await (await list(asBob)).text()).not.toContain("secret");
    expect(
      (await listBody(asBob, "?q=blocked-by%3Aacme%2Fsecret%236")).total,
    ).toBe(0);
  });
});

describe("GET /api/issues performance", () => {
  it("answers a filtered request over 10,000 accessible issues in under 1,000 ms", async () => {
    const alice = addUser(database.db, "octocat");
    const repos = Array.from({ length: 20 }, (_, index) =>
      addRepo("acme", `repo-${String(index)}`, [alice.id]),
    );
    const rows: ReturnType<typeof issueRow>[] = [];
    for (let index = 0; index < 10_000; index++) {
      const repo = repos[index % repos.length] as string;
      rows.push(
        issueRow(repo, {
          number: Math.floor(index / repos.length) + 1,
          title: `Issue ${String(index)} ${index % 7 === 0 ? "crash" : "feature"}`,
          authorLogin: index % 5 === 0 ? "octocat" : "alice",
          updatedAt: 1_000_000 + index,
          blockedByTotal: index % 11 === 0 ? 1 : 0,
        }),
      );
    }
    database.db.transaction((tx) => {
      for (let start = 0; start < rows.length; start += 200) {
        tx.insert(schema.issues)
          .values(rows.slice(start, start + 200))
          .run();
      }
      const labelRows = repos.map((repo, index) => ({
        id: `L_perf_${String(index)}`,
        repoId: repo,
        name: "bug",
        color: "d73a4a",
        description: null,
      }));
      tx.insert(schema.labels).values(labelRows).run();
      const links = rows.map((row, index) => ({
        issueId: row.id,
        labelId: `L_perf_${String(index % repos.length)}`,
      }));
      const assignees = rows.map((row) => ({
        issueId: row.id,
        login: "octocat",
        avatarUrl: "https://a/octocat",
      }));
      for (let start = 0; start < rows.length; start += 200) {
        tx.insert(schema.issueLabels)
          .values(links.slice(start, start + 200))
          .run();
        tx.insert(schema.issueAssignees)
          .values(assignees.slice(start, start + 200))
          .run();
      }
    });
    const { cookie } = signIn(database.db, alice.id);
    const app = build();

    const startedAt = performance.now();
    const response = await app.request(
      "/api/issues?q=label%3Abug+assignee%3A%40me+crash+-author%3Aalice&sort=title-asc&limit=200",
      { headers: { Cookie: cookie } },
    );
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(200);
    const body = issueListSchema.parse(await response.json());
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("GET /api/issues/:owner/:repo/:number", () => {
  const summary = (cookie: string, path: string) =>
    build().request(`/api/issues${path}`, { headers: { Cookie: cookie } });

  async function summaryBody(cookie: string, path: string) {
    const response = await summary(cookie, path);
    expect(response.status).toBe(200);
    return issueSummarySchema.parse(await response.json());
  }

  it("rejects a request without a session", async () => {
    const response = await build().request("/api/issues/acme/web/1");
    expect(response.status).toBe(401);
  });

  it("returns the issue item with the full dependency lists, their states and the parent", async () => {
    const alice = addUser(database.db, "octocat");
    const web = addRepo("acme", "web", [alice.id]);
    const api = addRepo("acme", "api", [alice.id]);
    addRef("R_parent", "acme/web", 7, "OPEN");
    addRef("R_b1", "acme/api", 2, "CLOSED");
    addRef("R_b2", "acme/api", 1, "OPEN");
    addRef("R_b3", "acme/web", 9, "OPEN");
    addRef("R_k1", "acme/web", 4, "OPEN");
    const target = addIssue(web, {
      number: 3,
      parentId: "R_parent",
      blockedByTotal: 3,
      blockingTotal: 1,
    });
    addIssue(api, { id: "R_b2", number: 1 });
    addIssue(web, { id: "R_k1", number: 4 });
    for (const blocker of ["R_b1", "R_b2", "R_b3"]) addDep(target, blocker);
    addDep("R_k1", target);

    const body = await summaryBody(
      signIn(database.db, alice.id).cookie,
      "/acme/web/3",
    );

    expect(body.id).toBe(target);
    expect(body.number).toBe(3);
    expect(body.isBlocked).toBe(true);
    expect(body.parent).toEqual({
      owner: "acme",
      repo: "web",
      number: 7,
      title: "Ref 7",
      state: "OPEN",
    });
    expect(body.blockedBy).toEqual({
      open: 2,
      notAccessible: 0,
      items: [
        {
          owner: "acme",
          repo: "api",
          number: 1,
          title: "Ref 1",
          state: "OPEN",
          url: "https://github.com/acme/api/issues/1",
          synced: true,
        },
        {
          owner: "acme",
          repo: "api",
          number: 2,
          title: "Ref 2",
          state: "CLOSED",
          url: "https://github.com/acme/api/issues/2",
          synced: false,
        },
        {
          owner: "acme",
          repo: "web",
          number: 9,
          title: "Ref 9",
          state: "OPEN",
          url: "https://github.com/acme/web/issues/9",
          synced: false,
        },
      ],
    });
    expect(body.blocking).toEqual({
      open: 1,
      notAccessible: 0,
      items: [
        {
          owner: "acme",
          repo: "web",
          number: 4,
          title: "Ref 4",
          state: "OPEN",
          url: "https://github.com/acme/web/issues/4",
          synced: true,
        },
      ],
    });
  });

  it("matches the repo case-insensitively and carries the list's item fields", async () => {
    const alice = addUser(database.db, "octocat");
    const web = addRepo("Acme", "Web", [alice.id]);
    addIssue(web, { number: 1, title: "Crash", typeName: "Bug" });
    const { cookie } = signIn(database.db, alice.id);

    const body = await summaryBody(cookie, "/acme/WEB/1");
    const listed = (await listBody(cookie)).items[0];

    expect(body.repo).toEqual({ owner: "Acme", name: "Web" });
    expect(body.title).toBe("Crash");
    expect({ ...body, blockedBy: undefined, blocking: undefined }).toEqual({
      ...listed,
      blockedBy: undefined,
      blocking: undefined,
    });
  });

  it("counts relations the viewer cannot read as max(0, total - readable) and never names them", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bobby");
    const web = addRepo("acme", "web", [alice.id, bob.id]);
    const secret = addRepo("acme", "secret", [alice.id]);
    addRef("R_parent", "acme/secret", 5, "OPEN");
    addRef("R_visible", "acme/web", 8, "OPEN");
    addRef("R_hidden", "acme/secret", 6, "OPEN");
    const target = addIssue(web, {
      number: 1,
      parentId: "R_parent",
      blockedByTotal: 3,
      blockingTotal: 1,
    });
    addIssue(secret, { id: "R_hidden", number: 6 });
    addDep(target, "R_visible");
    addDep(target, "R_hidden");

    const forAlice = await summaryBody(
      signIn(database.db, alice.id).cookie,
      "/acme/web/1",
    );
    expect(forAlice.parent?.title).toBe("Ref 5");
    expect(forAlice.blockedBy.notAccessible).toBe(1);
    expect(forAlice.blockedBy.items.map((entry) => entry.number)).toEqual([
      6, 8,
    ]);
    expect(forAlice.blocking.notAccessible).toBe(1);

    const forBob = await summary(
      signIn(database.db, bob.id).cookie,
      "/acme/web/1",
    );
    const text = await forBob.text();
    expect(forBob.status).toBe(200);
    const bobBody = issueSummarySchema.parse(JSON.parse(text));
    expect(bobBody.parent).toBeNull();
    expect(bobBody.blockedBy.notAccessible).toBe(2);
    expect(bobBody.blockedBy.open).toBe(1);
    expect(bobBody.blockedBy.items.map((entry) => entry.number)).toEqual([8]);
    expect(bobBody.blocking.notAccessible).toBe(1);
    expect(text).not.toContain("secret");
  });

  it("answers 404 for an issue that is not synced or not in the user's access", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bobby");
    const mine = addRepo("acme", "web", [alice.id]);
    const theirs = addRepo("acme", "private", [bob.id]);
    addIssue(mine, { number: 1 });
    addIssue(theirs, { number: 1 });
    const { cookie } = signIn(database.db, alice.id);

    expect((await summary(cookie, "/acme/web/1")).status).toBe(200);
    expect((await summary(cookie, "/acme/web/2")).status).toBe(404);
    expect((await summary(cookie, "/acme/private/1")).status).toBe(404);
    expect((await summary(cookie, "/acme/nowhere/1")).status).toBe(404);
    expect(
      (await summary(signIn(database.db, bob.id).cookie, "/acme/web/1")).status,
    ).toBe(404);
  });

  it("rejects an issue number that is not a positive integer", async () => {
    const alice = addUser(database.db, "octocat");
    const { cookie } = signIn(database.db, alice.id);

    expect((await summary(cookie, "/acme/web/abc")).status).toBe(400);
    expect((await summary(cookie, "/acme/web/0")).status).toBe(400);
  });
});
