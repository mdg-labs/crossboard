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

function build(credentials = true, appSecret = APP_SECRET) {
  const logger = createLogger("trace", { write: (chunk) => logs.push(chunk) });
  return createUserTokens({
    db: database.db,
    github: createGithubClient({
      apiUrl: FAKE_API_URL,
      webUrl: FAKE_WEB_URL,
      sleep: () => Promise.resolve(),
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
    appSecret,
    logger,
    now: () => NOW,
  });
}

function seed(
  tokens: Parameters<typeof storeTokens>[3],
  appSecret = APP_SECRET,
) {
  const user = addUser(database.db);
  storeTokens(database.db, appSecret, user.id, {
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

  describe("when GitHub rejects the access token with 401", () => {
    it("deletes the user's tokens and sessions, and no other user's", () => {
      const userId = seed({ access: "ghu_revoked" });
      const other = seed({ access: "ghu_other" });

      expect(build().rejected(userId, "ghu_revoked")).toBe(true);

      expect(stored(userId)).toBeUndefined();
      expect(sessionsOf(userId)).toEqual([]);
      expect(stored(other)).toBeDefined();
      expect(sessionsOf(other)).toHaveLength(1);
      const warned = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.level === 40);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({ userId });
      expect(logs.join("")).not.toContain("ghu_revoked");
    });

    it("changes nothing when the stored access token is no longer the rejected one", () => {
      const userId = seed({ access: "ghu_new" });
      const before = stored(userId);

      expect(build().rejected(userId, "ghu_old")).toBe(false);

      expect(stored(userId)).toEqual(before);
      expect(sessionsOf(userId)).toHaveLength(1);
    });

    it("changes nothing for a user without stored tokens", () => {
      const user = addUser(database.db);
      signIn(database.db, user.id, NOW);
      expect(build().rejected(user.id, "ghu_old")).toBe(false);
      expect(sessionsOf(user.id)).toHaveLength(1);
    });
  });

  describe("when the stored tokens no longer decrypt under the current secret", () => {
    const OLD_SECRET = "b".repeat(32);
    const warnings = () =>
      logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.level === 40);

    function expectSignedOut(userId: number, other: number) {
      expect(stored(userId)).toBeUndefined();
      expect(sessionsOf(userId)).toEqual([]);
      expect(stored(other)).toBeDefined();
      expect(sessionsOf(other)).toHaveLength(1);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toMatchObject({ userId });
      const output = logs.join("");
      for (const value of ["ghu_old_key", "refresh_old_key"]) {
        expect(output).not.toContain(value);
      }
      expect(output).not.toContain(stored(other)?.accessTokenEnc ?? "-");
    }

    it("deletes the user's tokens and sessions and returns null for a current access token, leaving other users alone", async () => {
      const userId = seed(
        { access: "ghu_old_key", refresh: "refresh_old_key" },
        OLD_SECRET,
      );
      const other = seed({ access: "ghu_other" });

      expect(await build().accessToken(userId)).toBeNull();

      expectSignedOut(userId, other);
      expect(await build().accessToken(other)).toBe("ghu_other");
      expect(fake.requests).toEqual([]);
    });

    it("deletes the user's tokens and sessions and returns null when the access token is due for a refresh", async () => {
      const userId = seed(
        {
          access: "ghu_old_key",
          refresh: "refresh_old_key",
          accessExpiresAt: NOW,
        },
        OLD_SECRET,
      );
      const other = seed({ access: "ghu_other" });

      expect(await build().accessToken(userId)).toBeNull();

      expectSignedOut(userId, other);
      expect(fake.requests).toEqual([]);
    });

    it("deletes the user's tokens and sessions when only the refresh token cannot be decrypted", async () => {
      const userId = seed({
        access: "ghu_old_key",
        refresh: "refresh_old_key",
        accessExpiresAt: NOW,
      });
      database.db
        .update(schema.userTokens)
        .set({ refreshTokenEnc: "v1:not:valid:format" })
        .where(eq(schema.userTokens.userId, userId))
        .run();
      const other = seed({ access: "ghu_other" });

      expect(await build().accessToken(userId)).toBeNull();

      expectSignedOut(userId, other);
      expect(fake.requests).toEqual([]);
    });

    it("deletes the user's tokens and sessions when 401 is reported for it", () => {
      const userId = seed(
        { access: "ghu_old_key", refresh: "refresh_old_key" },
        OLD_SECRET,
      );
      const other = seed({ access: "ghu_other" });

      expect(build().rejected(userId, "ghu_old_key")).toBe(true);

      expectSignedOut(userId, other);
    });
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
