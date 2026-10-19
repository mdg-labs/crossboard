import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { findSession, SESSION_COOKIE } from "../src/auth/sessions/index.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig, type Config } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { decrypt } from "../src/security/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
  fakeUser,
} from "./github-fake.js";
import { SENTINEL, validEnv } from "./helpers.js";

const ORIGIN = validEnv.CROSSBOARD_PUBLIC_URL;
const APP_SECRET = validEnv.CROSSBOARD_APP_SECRET;
const STATE_COOKIE = "crossboard_oauth";

const ACCESS_TOKEN = `ghu_access_${SENTINEL}`;
const REFRESH_TOKEN = `ghr_refresh_${SENTINEL}`;
const CODE = `code-${SENTINEL}`;

const githubApp = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "crossboard",
  GITHUB_CLIENT_ID: CLIENT_ID,
  GITHUB_CLIENT_SECRET: CLIENT_SECRET,
  GITHUB_PRIVATE_KEY: "private-key-value",
  GITHUB_WEBHOOK_SECRET: "webhook-secret-value",
};

const fake = createFakeGithub();
beforeAll(() => fake.listen());
afterAll(() => fake.close());

let dir: string;
let database: TestDatabase;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossboard-oauth-"));
  const webRoot = join(dir, "dist");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><p>shell</p>");
  database = createTestDatabase();
  logs = [];
  fake.server.use(
    http.post(
      `${FAKE_WEB_URL}/login/oauth/access_token`,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, string>;
        return body.code === CODE &&
          body.client_id === CLIENT_ID &&
          body.client_secret === CLIENT_SECRET &&
          body.redirect_uri === `${ORIGIN}/auth/callback`
          ? HttpResponse.json({
              access_token: ACCESS_TOKEN,
              expires_in: 28800,
              refresh_token: REFRESH_TOKEN,
              refresh_token_expires_in: 15811200,
              token_type: "bearer",
            })
          : HttpResponse.json({
              error: "bad_verification_code",
              error_description: "The code passed is incorrect or expired.",
            });
      },
    ),
    http.get(`${FAKE_API_URL}/user`, ({ request }) =>
      request.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`
        ? HttpResponse.json(fakeUser)
        : HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
    ),
    http.get(`${FAKE_API_URL}/user/installations`, ({ request }) =>
      request.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`
        ? HttpResponse.json({
            total_count: 2,
            installations: [
              {
                id: 1,
                app_id: 99,
                target_type: "User",
                account: { id: 11, login: "Somebody", type: "User" },
                suspended_at: null,
                repository_selection: "all",
              },
              {
                id: 2,
                app_id: 99,
                target_type: "Organization",
                account: { id: 12, login: "Acme-Corp", type: "Organization" },
                suspended_at: null,
                repository_selection: "all",
              },
            ],
          })
        : HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
    ),
  );
});

afterEach(() => {
  fake.reset();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build(env: Record<string, string> = {}) {
  const config: Config = loadConfig({
    ...validEnv,
    ...githubApp,
    CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
    CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    ...env,
  });
  const logger = createLogger("trace", { write: (chunk) => logs.push(chunk) });
  const setup = createSetup({ db: database.db, config, logger });
  setup.start();
  const app = createApp({
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
  return { app, config };
}

type App = ReturnType<typeof build>["app"];

const cookiePair = (response: Response, name: string) => {
  const header = response.headers
    .getSetCookie()
    .find((entry) => entry.startsWith(`${name}=`));
  return header?.split("; ")[0];
};

/** Starts the flow and returns the state GitHub would echo plus the cookie. */
async function startLogin(app: App, query = "") {
  const response = await app.request(`/auth/login${query}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  return {
    response,
    location,
    state,
    cookie: cookiePair(response, STATE_COOKIE) ?? "",
  };
}

const callback = (app: App, query: string, cookie?: string) =>
  app.request(`/auth/callback?${query}`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });

async function signInThroughGithub(app: App, query = "") {
  const { state, cookie } = await startLogin(app, query);
  return callback(
    app,
    `code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(state)}`,
    cookie,
  );
}

const rows = () => ({
  users: database.db.select().from(schema.users).all(),
  tokens: database.db.select().from(schema.userTokens).all(),
  sessions: database.db.select().from(schema.sessions).all(),
});

const expectNothingStored = () => {
  const stored = rows();
  expect(stored.users).toEqual([]);
  expect(stored.tokens).toEqual([]);
  expect(stored.sessions).toEqual([]);
};

describe("GET /auth/login", () => {
  it("redirects to GitHub's authorize URL with the client id, callback and a state", async () => {
    const { app } = build();
    const { response, location, state, cookie } = await startLogin(app);

    expect(`${location.origin}${location.pathname}`).toBe(
      `${FAKE_WEB_URL}/login/oauth/authorize`,
    );
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/auth/callback`,
    );
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toContain(state);

    const header =
      response.headers
        .getSetCookie()
        .find((entry) => entry.startsWith(`${STATE_COOKIE}=`)) ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=600");
    expect(rows().sessions).toEqual([]);
  });

  it("uses a fresh state for every login", async () => {
    const { app } = build();
    const first = await startLogin(app);
    const second = await startLogin(app);
    expect(first.state).not.toBe(second.state);
  });

  it("is reachable without a session", async () => {
    const response = await build().app.request("/auth/login");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/login/oauth/authorize",
    );
  });
});

describe("GET /auth/callback state check", () => {
  it.each([
    ["no state parameter", () => ""],
    ["a different state", () => "&state=not-the-state"],
  ])("rejects %s with no side effect", async (_name, extra) => {
    const { app } = build();
    const { cookie } = await startLogin(app);
    const response = await callback(
      app,
      `code=${encodeURIComponent(CODE)}${extra()}`,
      cookie,
    );
    expect(response.status).toBe(400);
    expectNothingStored();
    expect(fake.requests).toEqual([]);
  });

  it("rejects a callback without the state cookie with no side effect", async () => {
    const { app } = build();
    const { state } = await startLogin(app);
    const response = await callback(
      app,
      `code=${encodeURIComponent(CODE)}&state=${state}`,
    );
    expect(response.status).toBe(400);
    expectNothingStored();
    expect(fake.requests).toEqual([]);
  });

  it("rejects a callback that GitHub reports as denied", async () => {
    const { app } = build();
    const { state, cookie } = await startLogin(app);
    const response = await callback(
      app,
      `error=access_denied&state=${state}`,
      cookie,
    );
    expect(response.status).toBe(400);
    expectNothingStored();
    expect(fake.requests).toEqual([]);
  });
});

describe("the allowlist", () => {
  it("admits a user whose login is allowed, ignoring case, without looking up installations", async () => {
    // The user row is written right after the allowlist decision, so a lookup
    // that finds no user row yet was made to take that decision.
    const lookups: { path: string; usersStored: number }[] = [];
    fake.server.use(
      http.get(`${FAKE_API_URL}/user/installations`, ({ request }) => {
        lookups.push({
          path: new URL(request.url).pathname,
          usersStored: rows().users.length,
        });
        return HttpResponse.json({ total_count: 0, installations: [] });
      }),
    );
    const { app } = build({ CROSSBOARD_ALLOWED_USERS: "OCTOCAT" });
    const response = await signInThroughGithub(app);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(rows().users.map((user) => user.login)).toEqual(["octocat"]);
    // The access computation after admission does read the installations, so
    // the check below is not vacuous.
    expect(lookups.length).toBeGreaterThan(0);
    expect(
      lookups.filter((lookup) => lookup.usersStored === 0),
      "installation lookups made before the user was admitted",
    ).toEqual([]);
  });

  it("admits a user with an installation of an allowed org, ignoring case", async () => {
    const { app } = build({
      CROSSBOARD_ALLOWED_USERS: "someone-else",
      CROSSBOARD_ALLOWED_ORGS: "ACME-CORP",
    });
    const response = await signInThroughGithub(app);
    expect(response.headers.get("location")).toBe("/");
    expect(rows().users).toHaveLength(1);
    expect(rows().sessions).toHaveLength(1);
  });

  it("sends a non-allowed account to /auth/not-allowed and stores nothing", async () => {
    const { app } = build({
      CROSSBOARD_ALLOWED_USERS: "someone-else",
      CROSSBOARD_ALLOWED_ORGS: "other-org",
    });
    const response = await signInThroughGithub(app);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/not-allowed");
    expectNothingStored();
    expect(
      response.headers
        .getSetCookie()
        .some((entry) => entry.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
  });

  it("does not match an org login by prefix", async () => {
    const { app } = build({
      CROSSBOARD_ALLOWED_USERS: "someone-else",
      CROSSBOARD_ALLOWED_ORGS: "acme",
    });
    const response = await signInThroughGithub(app);
    expect(response.headers.get("location")).toBe("/auth/not-allowed");
    expectNothingStored();
  });

  it("serves /auth/not-allowed to a visitor without a session", async () => {
    const response = await build().app.request("/auth/not-allowed");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("shell");
  });
});

describe("an allowed sign-in", () => {
  it("creates the user, encrypted tokens with their expiry and a session", async () => {
    const { app } = build();
    const before = Date.now();
    const response = await signInThroughGithub(app);
    const after = Date.now();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const { users, tokens, sessions } = rows();
    expect(users).toHaveLength(1);
    const [user] = users;
    expect(user).toMatchObject({
      githubId: fakeUser.id,
      login: fakeUser.login,
      name: fakeUser.name,
      avatarUrl: fakeUser.avatar_url,
    });
    expect(user?.lastLoginAt).toBeGreaterThanOrEqual(before);
    expect(user?.lastLoginAt).toBeLessThanOrEqual(after);

    expect(tokens).toHaveLength(1);
    const [stored] = tokens;
    expect(stored?.userId).toBe(user?.id);
    expect(decrypt(stored?.accessTokenEnc ?? "", APP_SECRET)).toBe(
      ACCESS_TOKEN,
    );
    expect(decrypt(stored?.refreshTokenEnc ?? "", APP_SECRET)).toBe(
      REFRESH_TOKEN,
    );
    expect(stored?.accessExpiresAt).toBeGreaterThanOrEqual(
      before + 28800 * 1000,
    );
    expect(stored?.accessExpiresAt).toBeLessThanOrEqual(after + 28800 * 1000);
    expect(stored?.refreshExpiresAt).toBeGreaterThanOrEqual(
      before + 15811200 * 1000,
    );
    expect(stored?.refreshExpiresAt).toBeLessThanOrEqual(
      after + 15811200 * 1000,
    );

    expect(sessions).toHaveLength(1);
    const header =
      response.headers
        .getSetCookie()
        .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    const token = header.split("; ")[0]?.split("=")[1] ?? "";
    expect(findSession(database.db, token)?.userId).toBe(user?.id);
  });

  it("lands on the return path, and the session opens the app", async () => {
    const { app } = build();
    const response = await signInThroughGithub(
      app,
      `?return=${encodeURIComponent("/i/acme/widgets/7?x=1")}`,
    );
    expect(response.headers.get("location")).toBe("/i/acme/widgets/7?x=1");
    const cookie = cookiePair(response, SESSION_COOKIE) ?? "";
    const signedIn = await app.request("/api/nope", {
      headers: { Cookie: cookie },
    });
    expect(signedIn.status).toBe(404);
    expect((await app.request("/api/nope")).status).toBe(401);
  });

  it.each([
    "//evil.example/path",
    "https://evil.example/",
    "/\\evil.example",
    "evil",
  ])("falls back to / for the return value %s", async (value) => {
    const { app } = build();
    const response = await signInThroughGithub(
      app,
      `?return=${encodeURIComponent(value)}`,
    );
    expect(response.headers.get("location")).toBe("/");
  });

  it("updates an existing user and replaces their token row", async () => {
    const { app } = build();
    const existing = database.db
      .insert(schema.users)
      .values({
        githubId: fakeUser.id,
        login: "old-login",
        name: null,
        avatarUrl: "https://avatars.example/old",
        createdAt: 5,
        lastLoginAt: 5,
      })
      .returning()
      .get();
    database.db
      .insert(schema.userTokens)
      .values({
        userId: existing.id,
        accessTokenEnc: "v1:old:old:old",
        accessExpiresAt: 1,
        refreshTokenEnc: "v1:old:old:old",
        refreshExpiresAt: 1,
        updatedAt: 1,
      })
      .run();

    await signInThroughGithub(app);

    const { users, tokens } = rows();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: existing.id,
      login: fakeUser.login,
      name: fakeUser.name,
      avatarUrl: fakeUser.avatar_url,
      createdAt: 5,
    });
    expect(users[0]?.lastLoginAt).toBeGreaterThan(5);
    expect(tokens).toHaveLength(1);
    expect(decrypt(tokens[0]?.accessTokenEnc ?? "", APP_SECRET)).toBe(
      ACCESS_TOKEN,
    );
  });

  it("keeps the database free of plaintext tokens and the logs and responses too", async () => {
    const { app } = build();
    const { state, cookie, response: loginResponse } = await startLogin(app);
    const response = await callback(
      app,
      `code=${encodeURIComponent(CODE)}&state=${state}`,
      cookie,
    );
    const body = await response.text();
    const dumped = JSON.stringify(rows());
    const everything = [
      dumped,
      logs.join(""),
      body,
      [...response.headers].flat().join("\n"),
      [...loginResponse.headers].flat().join("\n"),
    ].join("\n");

    expect(rows().tokens).toHaveLength(1);
    expect(everything).not.toContain(ACCESS_TOKEN);
    expect(everything).not.toContain(REFRESH_TOKEN);
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain(CLIENT_SECRET);
    for (const table of ["user_tokens", "users", "sessions", "app_config"]) {
      const raw = JSON.stringify(
        database.sqlite.prepare(`SELECT * FROM ${table}`).all(),
      );
      expect(raw).not.toContain(SENTINEL);
    }
  });

  it("clears the state cookie so the callback cannot be replayed", async () => {
    const { app } = build();
    const { state, cookie } = await startLogin(app);
    const response = await callback(
      app,
      `code=${encodeURIComponent(CODE)}&state=${state}`,
      cookie,
    );
    const cleared =
      response.headers
        .getSetCookie()
        .find((entry) => entry.startsWith(`${STATE_COOKIE}=`)) ?? "";
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

describe("a sign-in that fails", () => {
  it("answers 502 and stores nothing when GitHub rejects the code", async () => {
    const { app } = build();
    const { state, cookie } = await startLogin(app);
    const response = await callback(app, `code=wrong&state=${state}`, cookie);
    expect(response.status).toBe(502);
    expectNothingStored();
  });

  it("answers 502 and stores nothing when the identity lookup fails", async () => {
    fake.server.use(
      http.get(`${FAKE_API_URL}/user`, () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );
    const { app } = build();
    const response = await signInThroughGithub(app);
    expect(response.status).toBe(502);
    expectNothingStored();
  });

  it("answers 502 and stores nothing when the installation lookup fails", async () => {
    fake.server.use(
      http.get(`${FAKE_API_URL}/user/installations`, () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );
    const { app } = build({
      CROSSBOARD_ALLOWED_USERS: "someone-else",
      CROSSBOARD_ALLOWED_ORGS: "acme-corp",
    });
    const response = await signInThroughGithub(app);
    expect(response.status).toBe(502);
    expectNothingStored();
  });

  it("leaves no user or token row when the session cannot be created", async () => {
    database.sqlite.exec(
      "CREATE TRIGGER no_sessions BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'no sessions'); END",
    );
    const { app } = build();
    const response = await signInThroughGithub(app);
    expect(response.status).toBe(500);
    expectNothingStored();
  });
});
