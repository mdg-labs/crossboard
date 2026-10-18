import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { accessHandlers, type World } from "./access.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
} from "./github-fake.js";
import { validEnv } from "./helpers.js";

const people = {
  alice: { id: 1, token: "ghu_alice_access" },
  bob: { id: 2, token: "ghu_bob_access" },
} as const;

const fake = createFakeGithub();
beforeAll(() => fake.listen());
afterAll(() => fake.close());

let dir: string;
let database: TestDatabase;
let logs: Record<string, unknown>[];
let worlds: Record<string, World>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossboard-access-signin-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
  database = createTestDatabase();
  logs = [];
  worlds = {};
  fake.server.use(
    ...accessHandlers(worlds),
    http.post(
      `${FAKE_WEB_URL}/login/oauth/access_token`,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, string>;
        const person = people[body.code?.replace("code-", "") as "alice"];
        return person === undefined
          ? HttpResponse.json({ error: "bad_verification_code" })
          : HttpResponse.json({
              access_token: person.token,
              expires_in: 28800,
              refresh_token: `${person.token}_refresh`,
              refresh_token_expires_in: 15811200,
            });
      },
    ),
    http.get(`${FAKE_API_URL}/user`, ({ request }) => {
      const token = (request.headers.get("authorization") ?? "").replace(
        "Bearer ",
        "",
      );
      const [login, person] =
        Object.entries(people).find(([, entry]) => entry.token === token) ?? [];
      return person === undefined
        ? HttpResponse.json({ message: "Bad credentials" }, { status: 401 })
        : HttpResponse.json({
            id: person.id,
            login,
            name: login,
            avatar_url: "https://avatars.githubusercontent.com/u/1",
          });
    }),
  );
});

afterEach(() => {
  fake.reset();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build() {
  const config = loadConfig({
    ...validEnv,
    CROSSBOARD_ALLOWED_USERS: "alice,bob",
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "crossboard",
    GITHUB_CLIENT_ID: CLIENT_ID,
    GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    GITHUB_PRIVATE_KEY: "private-key-value",
    GITHUB_WEBHOOK_SECRET: "webhook-secret-value",
    CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
    CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
  });
  const logger = createLogger("trace", {
    write: (chunk) => logs.push(JSON.parse(chunk)),
  });
  const setup = createSetup({ db: database.db, config, logger });
  setup.start();
  return createApp({
    logger,
    db: database.db,
    github: createGithubClient({
      apiUrl: config.githubApiUrl,
      webUrl: config.githubWebUrl,
      logger,
    }),
    version: "1.0.0",
    webRoot: join(dir, "dist"),
    setup,
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
  });
}

async function signInAs(app: ReturnType<typeof build>, name: string) {
  const login = await app.request("/auth/login");
  const state = new URL(login.headers.get("location") ?? "").searchParams.get(
    "state",
  );
  const cookie = (login.headers.getSetCookie()[0] ?? "").split("; ")[0] ?? "";
  return app.request(`/auth/callback?code=code-${name}&state=${state}`, {
    headers: { Cookie: cookie },
  });
}

const accessOf = (login: string) => {
  const user = database.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.login, login))
    .get();
  return database.db
    .select({ repoId: schema.userRepoAccess.repoId })
    .from(schema.userRepoAccess)
    .where(eq(schema.userRepoAccess.userId, user?.id ?? -1))
    .all()
    .map((row) => row.repoId)
    .sort();
};

const repoOf = (id: number, owner: string, name: string) => ({
  id,
  nodeId: `R_${String(id)}`,
  owner,
  name,
});

describe("computing access at sign-in", () => {
  it("stores the signed-in user's installations and repos before the redirect", async () => {
    worlds[people.alice.token] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repoOf(10, "alice", "notes")] },
    };
    const response = await signInAs(build(), "alice");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(accessOf("alice")).toEqual(["R_10"]);
    expect(database.db.select().from(schema.installations).all()).toHaveLength(
      1,
    );
    expect(database.db.select().from(schema.repos).all()).toMatchObject([
      { id: "R_10", syncState: "pending" },
    ]);
  });

  it("gives each user only their own repos when two users sign in", async () => {
    worlds[people.alice.token] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repoOf(10, "alice", "notes")] },
    };
    worlds[people.bob.token] = {
      installations: [{ id: 2, login: "bob" }],
      repos: { 2: [repoOf(20, "bob", "private-thing")] },
    };
    const app = build();
    await signInAs(app, "alice");
    await signInAs(app, "bob");

    expect(accessOf("alice")).toEqual(["R_10"]);
    expect(accessOf("bob")).toEqual(["R_20"]);
  });

  it("still signs the user in, with no access, when GitHub fails the computation", async () => {
    worlds[people.alice.token] = {
      installations: [{ id: 1, login: "alice" }],
      repos: { 1: [repoOf(10, "alice", "notes")] },
      failing: [1],
    };
    const response = await signInAs(build(), "alice");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(database.db.select().from(schema.sessions).all()).toHaveLength(1);
    expect(accessOf("alice")).toEqual([]);
    expect(
      logs.some(
        (entry) =>
          entry.msg === "computing the user's access at sign-in failed",
      ),
    ).toBe(true);
  });
});
