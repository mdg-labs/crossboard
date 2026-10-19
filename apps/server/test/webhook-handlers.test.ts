import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
import { activeInstallationIds } from "../src/access/index.js";
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig, type GithubAppCredentials } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import {
  createGithubClient,
  createInstallationClient,
} from "../src/github/index.js";
import { createJobs, type Jobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import { createRefetch } from "../src/sync/refetch.js";
import { createSync } from "../src/sync/sync.js";
import { createWebhookHandlers } from "../src/webhooks/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
} from "./github-fake.js";
import { githubEnv, validEnv } from "./helpers.js";
import { createTestAccess } from "./sign-in.js";
import {
  createFakeSyncGithub,
  type FakeIssue,
  type FakeRef,
  type FakeRepo,
} from "./sync-fake.js";

const SECRET = githubEnv.GITHUB_WEBHOOK_SECRET;
const ACTIVE = 7;
const INACTIVE = 8;
const WEB = "R_web";
const API = "R_api";
const DEBOUNCE_MS = 30;
const SETTLE_MS = 200;

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

let dir: string;
let database: TestDatabase;
let jobs: Jobs;
let logs: Record<string, unknown>[];
let web: FakeRepo;
let api: FakeRepo;

beforeAll(() => fake.listen());
afterAll(() => fake.close());

const ref = (number: number, repo = "acme/web"): FakeRef => ({
  id: `I_${String(number)}`,
  repo,
  number,
});

const issue = (number: number, extra: Partial<FakeIssue> = {}): FakeIssue => ({
  id: `I_${String(number)}`,
  repo: "acme/web",
  number,
  ...extra,
});

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-webhook-handlers-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
  logs = [];
  fake.server.use(...github.handlers);
  for (const [id, login] of [
    [ACTIVE, "octocat"],
    [INACTIVE, "stranger"],
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
  const bug = { id: "L_bug", name: "bug", color: "d73a4a" };
  web = {
    name: "acme/web",
    id: WEB,
    issues: [
      issue(1, { labels: [bug], blocking: [ref(2)] }),
      issue(2, { blockedBy: [ref(1)] }),
      issue(3, { labels: [bug] }),
    ],
  };
  api = {
    name: "acme/api",
    id: API,
    issues: [
      issue(10, {
        repo: "acme/api",
        labels: [{ id: "L_bug_api", name: "bug", color: "ffffff" }],
      }),
    ],
  };
});

afterEach(async () => {
  await jobs.stop();
  fake.reset();
  github.reset();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function addRepo(repo: FakeRepo, installationId: number) {
  const [owner = "", name = ""] = repo.name.split("/");
  database.db
    .insert(schema.repos)
    .values({
      id: repo.id,
      databaseId: repo.id === WEB ? 1 : 2,
      installationId,
      owner,
      name,
      private: true,
      syncState: "pending",
      openIssueCount: repo.issues.length,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  repo.installationId = installationId;
  github.world.repos.push(repo);
}

/** Builds the app with the production handlers, and syncs the repos into it. */
async function build(options: { debounceMs?: number } = {}) {
  const logger = createLogger("debug", {
    write: (chunk) => logs.push(JSON.parse(chunk) as Record<string, unknown>),
  });
  const config = loadConfig({ ...validEnv, ...githubEnv });
  const setup = createSetup({ db: database.db, config, logger });
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
  const isActive = (id: number) =>
    activeInstallationIds(database.db, setup.allowlist).has(id);
  const refetch = createRefetch({
    db: database.db,
    installations,
    isActive,
    logger,
  });
  jobs = createJobs({ logger });
  jobs.start();
  const handlers = createWebhookHandlers({
    db: database.db,
    jobs,
    issues: refetch,
    ...(options.debounceMs === undefined
      ? {}
      : { debounceMs: options.debounceMs }),
  });
  const sync = createSync({
    db: database.db,
    installations,
    isActive,
    refetch: (ids) => refetch.refetch(ids),
    logger,
  });
  addRepo(web, ACTIVE);
  addRepo(api, ACTIVE);
  await sync.syncRepo(WEB);
  await sync.syncRepo(API);
  github.world.requests = [];
  return createApp({
    logger,
    db: database.db,
    github: client,
    installations,
    jobs,
    webhookHandlers: handlers,
    version: "1.0.0",
    webRoot: join(dir, "dist"),
    setup,
    access: createTestAccess({
      db: database.db,
      github: client,
      setup,
      appSecret: config.appSecret,
      logger,
    }),
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
  });
}

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function deliver(
  app: Awaited<ReturnType<typeof build>>,
  event: string,
  payload: object,
  options: { installation?: number; secret?: string } = {},
) {
  const body = JSON.stringify({
    installation: { id: options.installation ?? ACTIVE },
    repository: { node_id: WEB, private: true },
    ...payload,
  });
  return app.request("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": `delivery-${String(Math.random())}`,
      "X-Hub-Signature-256": sign(body, options.secret),
    },
  });
}

const node = (id: string, extra: object = {}) => ({ node_id: id, ...extra });
const issueRows = () =>
  database.db.select().from(schema.issues).orderBy(schema.issues.number).all();
const issueIds = () => issueRows().map((row) => row.id);
const titleOf = (id: string) => issueRows().find((row) => row.id === id)?.title;
const refOf = (id: string) =>
  database.db
    .select()
    .from(schema.issueRefs)
    .where(eq(schema.issueRefs.id, id))
    .get();
const fetchedIds = () =>
  github
    .requestsFor("IssuesByIds")
    .flatMap((request) => request.variables.ids as string[]);
const labelRows = () =>
  database.db.select().from(schema.labels).orderBy(schema.labels.id).all();
const labelLinks = () =>
  database.db.select().from(schema.issueLabels).all().length;

describe("issues removals", () => {
  it("removes a closed issue as closed, leaving the issues it blocks pointing at it", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const first = web.issues[0];
    if (first === undefined) throw new Error("fixture");
    first.state = "CLOSED";
    const response = await deliver(app, "issues", {
      action: "closed",
      issue: node("I_1", { state: "open", title: "from the payload" }),
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(issueIds()).toEqual(["I_2", "I_3", "I_10"]);
    });
    expect(refOf("I_1")?.state).toBe("CLOSED");
    const deps = database.db.select().from(schema.issueDeps).all();
    expect(deps).toEqual([{ blockedId: "I_2", blockingId: "I_1" }]);
  });

  it.each(["deleted", "transferred"])(
    "removes a %s issue as gone: its refs and edges go and its neighbours are refetched",
    async (action) => {
      const app = await build({ debounceMs: DEBOUNCE_MS });
      web.issues = web.issues.filter((entry) => entry.id !== "I_2");
      github.world.hidden = [];
      await deliver(app, "issues", { action, issue: node("I_2") });
      await vi.waitFor(() => {
        expect(issueIds()).toEqual(["I_1", "I_3", "I_10"]);
      });
      expect(refOf("I_2")).toBeUndefined();
      expect(database.db.select().from(schema.issueDeps).all()).toEqual([]);
      expect(fetchedIds()).toContain("I_1");
    },
  );

  it("removes nothing for a delivery with an invalid signature or an inactive installation", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const forged = await deliver(
      app,
      "issues",
      { action: "deleted", issue: node("I_1") },
      { secret: "not-the-secret" },
    );
    expect(forged.status).toBe(401);
    const inactive = await deliver(
      app,
      "issues",
      { action: "deleted", issue: node("I_1") },
      { installation: INACTIVE },
    );
    expect(inactive.status).toBe(202);
    await sleep(SETTLE_MS);
    expect(issueIds()).toEqual(["I_1", "I_2", "I_3", "I_10"]);
    expect(github.world.requests).toEqual([]);
  });
});

describe("issues refetches", () => {
  it.each(["edited", "labeled", "assigned", "milestoned", "typed", "reopened"])(
    "refetches the issue on %s and reads no state from the payload",
    async (action) => {
      const app = await build({ debounceMs: DEBOUNCE_MS });
      const third = web.issues[2];
      if (third === undefined) throw new Error("fixture");
      third.title = "Title from GitHub";
      await deliver(app, "issues", {
        action,
        issue: node("I_3", { title: "Title from the payload", state: "open" }),
      });
      await vi.waitFor(() => {
        expect(titleOf("I_3")).toBe("Title from GitHub");
      });
      expect(fetchedIds()).toEqual(["I_3"]);
    },
  );

  it("stores an issue opened in a ready repo", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    web.issues.push(issue(4, { title: "Brand new" }));
    await deliver(app, "issues", {
      action: "opened",
      issue: node("I_4", { title: "Title from the payload" }),
    });
    await vi.waitFor(() => {
      expect(titleOf("I_4")).toBe("Brand new");
    });
    expect(issueRows().find((row) => row.id === "I_4")?.repoId).toBe(WEB);
  });

  it("leaves an issue of a repo that is not ready to its initial sync", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    database.db
      .update(schema.repos)
      .set({ syncState: "syncing" })
      .where(eq(schema.repos.id, WEB))
      .run();
    web.issues.push(issue(4));
    await deliver(app, "issues", { action: "opened", issue: node("I_4") });
    await sleep(SETTLE_MS);
    expect(issueIds()).not.toContain("I_4");
  });

  it("does not store an issue GitHub places in a repo that is not synced here", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    github.world.repos.push({
      name: "acme/elsewhere",
      id: "R_elsewhere",
      installationId: ACTIVE,
      issues: [issue(20, { repo: "acme/elsewhere" })],
    });
    await deliver(app, "issues", { action: "opened", issue: node("I_20") });
    await vi.waitFor(() => {
      expect(fetchedIds()).toEqual(["I_20"]);
    });
    await sleep(SETTLE_MS);
    expect(issueIds()).not.toContain("I_20");
  });

  it("stores a new sub-issue whose sub_issues delivery is processed before its opened one", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    web.issues.push(issue(4, { title: "Created as a sub-issue" }));
    await deliver(app, "sub_issues", {
      action: "parent_issue_added",
      parent_issue: node("I_4"),
      sub_issue: node("I_1"),
    });
    await deliver(app, "issues", { action: "opened", issue: node("I_4") });
    await vi.waitFor(() => {
      expect(titleOf("I_4")).toBe("Created as a sub-issue");
    });
    expect(issueRows().find((row) => row.id === "I_4")?.repoId).toBe(WEB);
  });

  it("stores a new issue whose issue_dependencies delivery is processed before its opened one", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    web.issues.push(
      issue(4, { title: "Created blocked", blockedBy: [ref(1)] }),
    );
    const first = web.issues[0];
    if (first === undefined) throw new Error("fixture");
    first.blocking = [ref(2), ref(4)];
    await deliver(app, "issue_dependencies", {
      action: "blocked_by_added",
      blocked_issue: node("I_4"),
      blocking_issue: node("I_1"),
    });
    await deliver(app, "issues", { action: "opened", issue: node("I_4") });
    await vi.waitFor(() => {
      expect(titleOf("I_4")).toBe("Created blocked");
    });
    expect(database.db.select().from(schema.issueDeps).all()).toContainEqual({
      blockedId: "I_4",
      blockingId: "I_1",
    });
  });

  it("brings a reopened issue back as open", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const first = web.issues[0];
    if (first === undefined) throw new Error("fixture");
    first.state = "CLOSED";
    await deliver(app, "issues", { action: "closed", issue: node("I_1") });
    await vi.waitFor(() => {
      expect(issueIds()).not.toContain("I_1");
    });
    first.state = "OPEN";
    await deliver(app, "issues", { action: "reopened", issue: node("I_1") });
    await vi.waitFor(() => {
      expect(issueIds()).toContain("I_1");
    });
    expect(refOf("I_1")?.state).toBe("OPEN");
  });

  it("removes an issue the refetch finds closed", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const third = web.issues[2];
    if (third === undefined) throw new Error("fixture");
    third.state = "CLOSED";
    await deliver(app, "issues", { action: "edited", issue: node("I_3") });
    await vi.waitFor(() => {
      expect(issueIds()).toEqual(["I_1", "I_2", "I_10"]);
    });
  });

  it("debounces deliveries per issue into one refetch, and keeps issues apart", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    for (const action of ["edited", "labeled", "unlabeled"]) {
      await deliver(app, "issues", { action, issue: node("I_3") });
    }
    await deliver(app, "issues", { action: "edited", issue: node("I_1") });
    await sleep(SETTLE_MS);
    expect(fetchedIds().sort()).toEqual(["I_1", "I_3"]);
  });

  it("enqueues the refetch 5 s out under a key per issue", async () => {
    const app = await build();
    const enqueue = vi.spyOn(jobs, "enqueue");
    await deliver(app, "issues", { action: "edited", issue: node("I_3") });
    expect(enqueue).toHaveBeenCalledWith(
      "webhook:issues",
      expect.anything(),
      expect.anything(),
    );
    await vi.waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith(
        "webhook.refetch-issue",
        { id: "I_3", installationId: ACTIVE },
        { key: "I_3", delayMs: 5000, installationId: ACTIVE },
      );
    });
    expect(github.world.requests).toEqual([]);
  });

  it("ignores a payload that names no issue, without logging it", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const response = await deliver(app, "issues", {
      action: "deleted",
      issue: { title: "sentinel-body-not-to-be-logged" },
    });
    expect(response.status).toBe(202);
    await sleep(SETTLE_MS);
    expect(issueIds()).toEqual(["I_1", "I_2", "I_3", "I_10"]);
    expect(
      logs.filter(
        (line) => line.msg === "webhook ignored: the payload names no issue",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(
      "sentinel-body-not-to-be-logged",
    );
  });
});

describe("sub_issues and issue_dependencies", () => {
  it("refetches the parent and the sub-issue", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    for (const entry of web.issues) entry.title = `GitHub ${entry.id}`;
    await deliver(app, "sub_issues", {
      action: "sub_issue_added",
      parent_issue: node("I_1", { title: "payload" }),
      sub_issue: node("I_3"),
    });
    await vi.waitFor(() => {
      expect(titleOf("I_1")).toBe("GitHub I_1");
      expect(titleOf("I_3")).toBe("GitHub I_3");
    });
    expect(titleOf("I_2")).toBe("Issue 2");
    expect(fetchedIds().sort()).toEqual(["I_1", "I_3"]);
  });

  it("refetches the blocked and the blocking issue", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const third = web.issues[2];
    if (third === undefined) throw new Error("fixture");
    third.blockedBy = [ref(1)];
    const first = web.issues[0];
    if (first === undefined) throw new Error("fixture");
    first.blocking = [ref(2), ref(3)];
    for (const entry of web.issues) entry.title = `GitHub ${entry.id}`;
    await deliver(app, "issue_dependencies", {
      action: "blocked_by_added",
      blocked_issue: node("I_3", {
        issue_dependencies_summary: { blocked_by: 0 },
      }),
      blocking_issue: node("I_1"),
    });
    await vi.waitFor(() => {
      expect(titleOf("I_1")).toBe("GitHub I_1");
      expect(titleOf("I_3")).toBe("GitHub I_3");
    });
    expect(fetchedIds().sort()).toEqual(["I_1", "I_3"]);
    expect(database.db.select().from(schema.issueDeps).all()).toContainEqual({
      blockedId: "I_3",
      blockingId: "I_1",
    });
  });

  it("refetches the side of a dependency in another repo with that repo's installation", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    for (const entry of [...web.issues, ...api.issues]) {
      entry.title = `GitHub ${entry.id}`;
    }
    await deliver(app, "issue_dependencies", {
      action: "blocking_added",
      blocked_issue: node("I_10"),
      blocking_issue: node("I_1"),
    });
    await vi.waitFor(() => {
      expect(titleOf("I_10")).toBe("GitHub I_10");
      expect(titleOf("I_1")).toBe("GitHub I_1");
    });
  });
});

describe("issue_comment", () => {
  function seedDetails(id: string) {
    database.db
      .insert(schema.issueDetails)
      .values({
        issueId: id,
        bodyHtml: "<p>cached</p>",
        commentsJson: "[]",
        commentsTotal: 0,
        subIssuesJson: JSON.stringify({ total: 0, items: [] }),
        fetchedForUpdatedAt: 1,
        fetchedAt: 1,
      })
      .run();
  }
  const detailIds = () =>
    database.db
      .select({ id: schema.issueDetails.issueId })
      .from(schema.issueDetails)
      .all()
      .map((row) => row.id);

  it("drops that issue's cached details and nothing else", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    seedDetails("I_1");
    seedDetails("I_2");
    const response = await deliver(app, "issue_comment", {
      action: "created",
      issue: node("I_1"),
      comment: { body: "hello" },
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(detailIds()).toEqual(["I_2"]);
    });
    expect(issueIds()).toEqual(["I_1", "I_2", "I_3", "I_10"]);
    expect(github.world.requests).toEqual([]);
  });
});

describe("label", () => {
  const edited = (id: string, extra: object = {}, repo = WEB) => ({
    action: "edited",
    repository: node(repo, { private: true }),
    label: node(id, {
      name: "defect",
      color: "0e8a16",
      description: "Something is broken",
      ...extra,
    }),
    changes: { name: { from: "bug" } },
  });

  it("updates the edited label in the repo that was named", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    await deliver(app, "label", edited("L_bug"));
    await vi.waitFor(() => {
      expect(labelRows().find((row) => row.id === "L_bug")?.name).toBe(
        "defect",
      );
    });
    expect(labelRows()).toEqual([
      {
        id: "L_bug",
        repoId: WEB,
        name: "defect",
        color: "0e8a16",
        description: "Something is broken",
      },
      expect.objectContaining({
        id: "L_bug_api",
        name: "bug",
        color: "ffffff",
      }),
    ]);
    expect(labelLinks()).toBe(3);
    expect(github.world.requests).toEqual([]);
  });

  it("does not touch a label the named repo does not own", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    await deliver(app, "label", edited("L_bug_api"));
    await deliver(app, "label", {
      ...edited("L_bug_api"),
      action: "deleted",
    });
    await sleep(SETTLE_MS);
    expect(labelRows().map((row) => [row.id, row.name])).toEqual([
      ["L_bug", "bug"],
      ["L_bug_api", "bug"],
    ]);
  });

  it("skips an update whose name another label of the repo holds", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    database.db
      .insert(schema.labels)
      .values({ id: "L_other", repoId: WEB, name: "defect", color: "000000" })
      .run();
    await deliver(app, "label", edited("L_bug"));
    await sleep(SETTLE_MS);
    expect(labelRows().map((row) => [row.id, row.name])).toEqual([
      ["L_bug", "bug"],
      ["L_bug_api", "bug"],
      ["L_other", "defect"],
    ]);
  });

  it("removes the deleted label and its rows on issues", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    await deliver(app, "label", {
      action: "deleted",
      label: node("L_bug", { name: "bug", color: "d73a4a" }),
    });
    await vi.waitFor(() => {
      expect(labelRows().map((row) => row.id)).toEqual(["L_bug_api"]);
    });
    expect(labelLinks()).toBe(1);
    expect(issueIds()).toEqual(["I_1", "I_2", "I_3", "I_10"]);
  });

  it("does nothing for any other action", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    for (const action of ["created", "renamed", "unknown"]) {
      await deliver(app, "label", { ...edited("L_bug"), action });
    }
    await sleep(SETTLE_MS);
    expect(labelRows().map((row) => [row.id, row.name])).toEqual([
      ["L_bug", "bug"],
      ["L_bug_api", "bug"],
    ]);
  });

  it("ignores a label payload without a repo", async () => {
    const app = await build({ debounceMs: DEBOUNCE_MS });
    const response = await deliver(app, "label", {
      action: "deleted",
      repository: {},
      label: node("L_bug", { name: "bug", color: "d73a4a" }),
    });
    expect(response.status).toBe(202);
    await sleep(SETTLE_MS);
    expect(labelRows()).toHaveLength(2);
  });
});
