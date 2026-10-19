import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc } from "hono/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppType } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { encrypt } from "../src/security/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { githubEnv, validEnv, unusedInstallations } from "./helpers.js";
import { addUser, signIn, createTestAccess } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-me-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build(env: Record<string, string> = {}) {
  const logger = createLogger("silent");
  const config = loadConfig({
    ...validEnv,
    ...githubEnv,
    CROSSBOARD_ALLOWED_USERS: "octocat",
    CROSSBOARD_ALLOWED_ORGS: "acme",
    ...env,
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

function addInstallation(
  id: number,
  accountLogin: string,
  accountType: "User" | "Organization",
  userIds: number[],
) {
  database.db
    .insert(schema.installations)
    .values({
      id,
      accountLogin,
      accountId: 5000 + id,
      accountType,
      suspended: false,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  for (const userId of userIds) {
    database.db
      .insert(schema.userInstallations)
      .values({ userId, installationId: id, computedAt: 1 })
      .run();
  }
}

describe("GET /api/me", () => {
  it("rejects a request without a session", async () => {
    const response = await build().request("/api/me");
    expect(response.status).toBe(401);
  });

  it("returns the session user, their installations with the active flag and the install URL", async () => {
    const alice = addUser(database.db, "octocat");
    addInstallation(2, "acme", "Organization", [alice.id]);
    addInstallation(1, "octocat", "User", [alice.id]);
    addInstallation(3, "stranger", "Organization", [alice.id]);
    const { cookie } = signIn(database.db, alice.id);

    const response = await build().request("/api/me", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
      installations: [
        {
          id: 2,
          accountLogin: "acme",
          accountType: "Organization",
          active: true,
        },
        { id: 1, accountLogin: "octocat", accountType: "User", active: true },
        {
          id: 3,
          accountLogin: "stranger",
          accountType: "Organization",
          active: true,
        },
      ],
      installUrl: "https://github.com/apps/crossboard/installations/new",
    });
  });

  it("flags an installation inactive when no allowed account reaches it", async () => {
    const mallory = addUser(database.db, "mallory");
    addInstallation(1, "mallory", "User", [mallory.id]);
    addInstallation(2, "elsewhere", "Organization", [mallory.id]);

    const response = await build().request("/api/me", {
      headers: { Cookie: signIn(database.db, mallory.id).cookie },
    });

    const body = (await response.json()) as {
      installations: { accountLogin: string; active: boolean }[];
    };
    expect(
      body.installations.map((entry) => [entry.accountLogin, entry.active]),
    ).toEqual([
      ["elsewhere", false],
      ["mallory", false],
    ]);
  });

  it("never lists another user's installations", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bob");
    addInstallation(1, "octocat", "User", [alice.id]);
    addInstallation(2, "bobs-org", "Organization", [bob.id]);
    addInstallation(3, "shared-org", "Organization", [alice.id, bob.id]);

    const asAlice = await build().request("/api/me", {
      headers: { Cookie: signIn(database.db, alice.id).cookie },
    });
    const asBob = await build().request("/api/me", {
      headers: { Cookie: signIn(database.db, bob.id).cookie },
    });

    const names = async (response: Response) =>
      (
        (await response.json()) as {
          installations: { accountLogin: string }[];
        }
      ).installations.map((entry) => entry.accountLogin);
    expect(await names(asAlice)).toEqual(["octocat", "shared-org"]);
    expect(await names(asBob)).toEqual(["bobs-org", "shared-org"]);
  });

  it("returns no token or secret", async () => {
    const alice = addUser(database.db, "octocat");
    addInstallation(1, "octocat", "User", [alice.id]);
    database.db
      .insert(schema.userTokens)
      .values({
        userId: alice.id,
        accessTokenEnc: encrypt(
          "ghu_access_value",
          validEnv.CROSSBOARD_APP_SECRET,
        ),
        accessExpiresAt: 1,
        refreshTokenEnc: encrypt(
          "ghr_refresh_value",
          validEnv.CROSSBOARD_APP_SECRET,
        ),
        refreshExpiresAt: 1,
        updatedAt: 1,
      })
      .run();
    const { cookie, token } = signIn(database.db, alice.id);

    const response = await build().request("/api/me", {
      headers: { Cookie: cookie },
    });
    const text = await response.text();

    for (const secret of [
      "ghu_access_value",
      "ghr_refresh_value",
      token,
      githubEnv.GITHUB_CLIENT_SECRET,
      githubEnv.GITHUB_PRIVATE_KEY,
      githubEnv.GITHUB_WEBHOOK_SECRET,
      validEnv.CROSSBOARD_APP_SECRET,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "installUrl",
      "installations",
      "user",
    ]);
  });

  it("builds the install URL from the configured GitHub web URL", async () => {
    const alice = addUser(database.db, "octocat");
    const response = await build({
      CROSSBOARD_GITHUB_WEB_URL: "https://ghe.example.com",
    }).request("/api/me", {
      headers: { Cookie: signIn(database.db, alice.id).cookie },
    });
    expect(((await response.json()) as { installUrl: string }).installUrl).toBe(
      "https://ghe.example.com/apps/crossboard/installations/new",
    );
  });

  it("is typed through hc<AppType>", async () => {
    const alice = addUser(database.db, "octocat");
    const app = build();
    const client = hc<AppType>("http://localhost", {
      fetch: app.request,
      headers: { Cookie: signIn(database.db, alice.id).cookie },
    });
    const response = await client.api.me.$get();
    const body = (await response.json()) as { user?: { login: string } };
    expect(body.user?.login).toBe("octocat");
  });
});

describe("/settings page", () => {
  it("sends a visitor without a session through sign-in and back", async () => {
    const response = await build().request("/settings");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/login?return=%2Fsettings",
    );
  });

  it("serves the app shell to a signed-in user", async () => {
    const { cookie } = signIn(database.db);
    const response = await build().request("/settings", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  });
});
