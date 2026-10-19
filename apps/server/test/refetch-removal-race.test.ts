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
import { createLogger } from "../src/logger.js";
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
import { createFakeSyncGithub, type FakeIssue } from "./sync-fake.js";

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

beforeAll(() => fake.listen());
afterAll(() => fake.close());

beforeEach(() => {
  database = createTestDatabase();
  fake.server.use(...github.handlers);
});

afterEach(() => {
  fake.reset();
  github.reset();
  database.cleanup();
});

const issue = (number: number, extra: Partial<FakeIssue> = {}): FakeIssue => ({
  id: `I_${String(number)}`,
  repo: "acme/web",
  number,
  ...extra,
});

const issueIds = () =>
  database.db
    .select({ id: schema.issues.id })
    .from(schema.issues)
    .orderBy(schema.issues.number)
    .all()
    .map((row) => row.id);

/** A synced repo `acme/web` of the issues `stored`, whose issue lookups can be held. */
async function setup(stored: FakeIssue[], hidden: FakeIssue[] = []) {
  database.db
    .insert(schema.installations)
    .values({
      id: 1,
      accountLogin: "acct-1",
      accountId: 1,
      accountType: "Organization",
      suspended: false,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  database.db
    .insert(schema.repos)
    .values({
      id: "R_1",
      databaseId: 1,
      installationId: 1,
      owner: "acme",
      name: "web",
      private: false,
      syncState: "pending",
      openIssueCount: stored.length,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const repo = {
    name: "acme/web",
    id: "R_1",
    installationId: 1,
    issues: stored,
  };
  github.world.repos.push(repo);
  const logger = createLogger("silent");
  const installations = createInstallationClient({
    github: createGithubClient({
      apiUrl: FAKE_API_URL,
      webUrl: FAKE_WEB_URL,
      sleep: () => Promise.resolve(),
      logger,
    }),
    credentials: () => credentials,
  });
  const refetch = createRefetch({
    db: database.db,
    installations,
    isActive: () => true,
    logger,
  });
  const sync = createSync({
    db: database.db,
    installations,
    isActive: () => true,
    refetch: (ids) => refetch.refetch(ids),
    logger,
  });
  await sync.syncRepo("R_1");
  github.world.hidden.push(...hidden);

  /** Holds the next issue lookup's answer until `release`, once it has been read. */
  let release = () => {};
  let arrived = () => {};
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = () => {
    github.world.holdIssueLookup = async () => {
      github.world.holdIssueLookup = undefined;
      arrived();
      await gate;
    };
    return { reached, release: () => release() };
  };
  return { repo, refetch, hold };
}

describe("a refetch and a removal of the same issue", () => {
  it.each(["closed", "gone"] as const)(
    "does not write back an issue removed as %s while its request was in flight",
    async (reason) => {
      const { repo, refetch, hold } = await setup([issue(1), issue(2)]);
      const lookup = hold();

      // GitHub reads both issues open; issue 2 is renamed in the same answer
      repo.issues = repo.issues.map((entry) =>
        entry.number === 2 ? { ...entry, title: "Two, renamed" } : entry,
      );
      const refetching = refetch.refetch(["I_1", "I_2"]);
      await lookup.reached;
      await refetch.remove(["I_1"], reason);
      lookup.release();
      await refetching;

      expect(issueIds()).toEqual(["I_2"]);
      expect(
        database.db
          .select({ title: schema.issues.title })
          .from(schema.issues)
          .where(eq(schema.issues.id, "I_2"))
          .get(),
      ).toEqual({ title: "Two, renamed" });
    },
  );

  it("does not adopt an issue removed while the adopting request was in flight", async () => {
    const { refetch, hold } = await setup([issue(1)], [issue(2)]);
    const lookup = hold();

    const refetching = refetch.refetch(["I_2"], 1);
    await lookup.reached;
    await refetch.remove(["I_2"], "closed");
    lookup.release();
    await refetching;

    expect(issueIds()).toEqual(["I_1"]);
  });

  it("stores an issue that GitHub reports open when the refetch starts after the removal", async () => {
    const { repo, refetch } = await setup([issue(1)]);
    await refetch.remove(["I_1"], "closed");
    expect(issueIds()).toEqual([]);

    // reopened on GitHub; the delivery names an issue that is not stored
    repo.issues = [issue(1, { title: "Reopened" })];
    await refetch.refetch(["I_1"], 1);

    expect(issueIds()).toEqual(["I_1"]);
  });

  it("keeps no record of a removal once the refetches that could have raced it are done", async () => {
    const { repo, refetch } = await setup([issue(1)]);
    await refetch.remove(["I_1"], "closed");

    repo.issues = [issue(1)];
    await refetch.refetch(["I_1"], 1);
    await refetch.remove(["I_1"], "closed");
    repo.issues = [issue(1, { title: "Reopened again" })];
    await refetch.refetch(["I_1"], 1);

    expect(issueIds()).toEqual(["I_1"]);
  });
});
