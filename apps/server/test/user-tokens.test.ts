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
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  createUserTokens,
} from "../src/auth/tokens.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { decrypt } from "../src/security/index.js";
import { storeTokens } from "./access.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
  fakeOAuthTokens,
} from "./github-fake.js";
import { addUser, signIn } from "./sign-in.js";

const APP_SECRET = "a".repeat(32);
const NOW = 1_800_000_000_000;
const MARGIN = ACCESS_TOKEN_REFRESH_MARGIN_MS;

const fake = createFakeGithub();
beforeAll(() => fake.listen());
afterAll(() => fake.close());

let database: TestDatabase;
let logs: string[];

beforeEach(() => {
  database = createTestDatabase();
  logs = [];
});

afterEach(() => {
  fake.reset();
  database.cleanup();
});

function build(credentials = true) {
  const logger = createLogger("trace", { write: (chunk) => logs.push(chunk) });
  return createUserTokens({
    db: database.db,
    github: createGithubClient({
      apiUrl: FAKE_API_URL,
      webUrl: FAKE_WEB_URL,
      logger,
    }),
    credentials: () =>
      credentials
        ? {
            appId: "1",
            appSlug: "x",
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            privateKey: "k",
            webhookSecret: "w",
          }
        : null,
    appSecret: APP_SECRET,
    logger,
    now: () => NOW,
  });
}

function seed(tokens: Parameters<typeof storeTokens>[3]) {
  const user = addUser(database.db);
  storeTokens(database.db, APP_SECRET, user.id, {
    accessExpiresAt: NOW + 8 * 3_600_000,
    refreshExpiresAt: NOW + 86_400_000,
    ...tokens,
  });
  signIn(database.db, user.id, NOW);
  return user.id;
}

const stored = (userId: number) =>
  database.db
    .select()
    .from(schema.userTokens)
    .where(eq(schema.userTokens.userId, userId))
    .get();

const sessionsOf = (userId: number) =>
  database.db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .all();

const refreshCalls = () =>
  fake.requests.filter((request) => request.method === "POST");

describe("a user's access token", () => {
  it("is returned as stored while it has the refresh margin left", async () => {
    const userId = seed({
      access: "ghu_current",
      accessExpiresAt: NOW + MARGIN,
    });
    expect(await build().accessToken(userId)).toBe("ghu_current");
    expect(fake.requests).toEqual([]);
  });

  it("is refreshed first when less than 5 minutes are left, and the rotated tokens are stored encrypted", async () => {
    const userId = seed({
      access: "ghu_old",
      refresh: "good-refresh",
      accessExpiresAt: NOW + MARGIN - 1,
    });
    expect(await build().accessToken(userId)).toBe(
      fakeOAuthTokens.access_token,
    );

    const row = stored(userId);
    expect(row?.accessTokenEnc).not.toContain(fakeOAuthTokens.access_token);
    expect(row?.refreshTokenEnc).not.toContain(fakeOAuthTokens.refresh_token);
    expect(decrypt(row?.accessTokenEnc ?? "", APP_SECRET)).toBe(
      fakeOAuthTokens.access_token,
    );
    expect(decrypt(row?.refreshTokenEnc ?? "", APP_SECRET)).toBe(
      fakeOAuthTokens.refresh_token,
    );
    expect(row?.accessExpiresAt).toBe(NOW + fakeOAuthTokens.expires_in * 1000);
    expect(row?.refreshExpiresAt).toBe(
      NOW + fakeOAuthTokens.refresh_token_expires_in * 1000,
    );
    expect(sessionsOf(userId)).toHaveLength(1);
  });

  it("is refreshed once when several callers ask at the same time", async () => {
    const userId = seed({
      access: "ghu_old",
      refresh: "good-refresh",
      accessExpiresAt: NOW,
    });
    const tokens = build();
    const results = await Promise.all([
      tokens.accessToken(userId),
      tokens.accessToken(userId),
      tokens.accessToken(userId),
    ]);
    expect(results).toEqual(Array(3).fill(fakeOAuthTokens.access_token));
    expect(refreshCalls()).toHaveLength(1);
  });

  it("deletes the user's tokens and sessions when GitHub rejects the refresh", async () => {
    const userId = seed({
      access: "ghu_old",
      refresh: "revoked-refresh",
      accessExpiresAt: NOW,
    });
    signIn(database.db, userId, NOW);
    const other = seed({ access: "ghu_other" });

    expect(await build().accessToken(userId)).toBeNull();

    expect(stored(userId)).toBeUndefined();
    expect(sessionsOf(userId)).toEqual([]);
    expect(stored(other)).toBeDefined();
    expect(sessionsOf(other)).toHaveLength(1);
  });

  it("deletes the user's tokens and sessions when the refresh token has expired, without calling GitHub", async () => {
    const userId = seed({
      access: "ghu_old",
      refresh: "good-refresh",
      accessExpiresAt: NOW,
      refreshExpiresAt: NOW,
    });
    expect(await build().accessToken(userId)).toBeNull();
    expect(stored(userId)).toBeUndefined();
    expect(sessionsOf(userId)).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("keeps the tokens and sessions when the refresh fails for another reason", async () => {
    fake.server.use(
      http.post(`${FAKE_WEB_URL}/login/oauth/access_token`, () =>
        HttpResponse.json({ message: "down" }, { status: 503 }),
      ),
    );
    const userId = seed({
      access: "ghu_old",
      refresh: "good-refresh",
      accessExpiresAt: NOW,
    });
    const before = stored(userId);
    await expect(build().accessToken(userId)).rejects.toThrow(/503/);
    expect(stored(userId)).toEqual(before);
    expect(sessionsOf(userId)).toHaveLength(1);
  });

  it("keeps the tokens and sessions when GitHub rejects the client credentials", async () => {
    fake.server.use(
      http.post(`${FAKE_WEB_URL}/login/oauth/access_token`, () =>
        HttpResponse.json({
          error: "incorrect_client_credentials",
          error_description:
            "The client_id and/or client_secret passed are incorrect.",
        }),
      ),
    );
    const userId = seed({
      access: "ghu_old",
      refresh: "good-refresh",
      accessExpiresAt: NOW,
    });
    const before = stored(userId);
    await expect(build().accessToken(userId)).rejects.toMatchObject({
      code: "incorrect_client_credentials",
    });
    expect(stored(userId)).toEqual(before);
    expect(sessionsOf(userId)).toHaveLength(1);
  });

  it.each([403, 429])(
    "keeps the tokens and sessions when the refresh fails with HTTP %i",
    async (status) => {
      fake.server.use(
        http.post(`${FAKE_WEB_URL}/login/oauth/access_token`, () =>
          HttpResponse.json({ message: "slow down" }, { status }),
        ),
      );
      const userId = seed({
        access: "ghu_old",
        refresh: "good-refresh",
        accessExpiresAt: NOW,
      });
      const before = stored(userId);
      await expect(build().accessToken(userId)).rejects.toMatchObject({
        status,
      });
      expect(stored(userId)).toEqual(before);
      expect(sessionsOf(userId)).toHaveLength(1);
    },
  );

  it("throws, changing nothing, when there are no App credentials to refresh with", async () => {
    const userId = seed({
      access: "ghu_old",
      refresh: "good-refresh",
      accessExpiresAt: NOW,
    });
    await expect(build(false).accessToken(userId)).rejects.toThrow(
      /credentials/,
    );
    expect(stored(userId)).toBeDefined();
    expect(sessionsOf(userId)).toHaveLength(1);
  });

  it("is null for a user without stored tokens", async () => {
    const userId = addUser(database.db).id;
    expect(await build().accessToken(userId)).toBeNull();
  });

  it("is never logged", async () => {
    const userId = seed({
      access: "ghu_old_secret_value",
      refresh: "good-refresh",
      accessExpiresAt: NOW,
    });
    await build().accessToken(userId);
    const output = logs.join("");
    for (const value of [
      "ghu_old_secret_value",
      "good-refresh",
      fakeOAuthTokens.access_token,
      fakeOAuthTokens.refresh_token,
    ]) {
      expect(output).not.toContain(value);
    }
  });
});
