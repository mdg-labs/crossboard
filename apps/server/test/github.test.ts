import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { http, HttpResponse } from "msw";
import {
  createGithubClient,
  GithubError,
  queries,
  type GithubClient,
} from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
  APP_ID,
  APP_PRIVATE_KEY,
  fakeInstallations,
  INSTALLATION_ID,
  issueInstallationToken,
  fakeRepositories,
  USER_TOKEN,
} from "./github-fake.js";

const fake = createFakeGithub();
const app = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

let logs: string[];
let client: GithubClient;

beforeAll(() => fake.listen());
afterAll(() => fake.close());
beforeEach(() => {
  logs = [];
  client = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    logger: createLogger("debug", { write: (chunk) => logs.push(chunk) }),
  });
});
afterEach(() => fake.reset());

describe("typed calls", () => {
  it("reads the signed-in user with the token it is given", async () => {
    expect(await client.getUser(USER_TOKEN)).toEqual({
      id: 583231,
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231",
    });
  });

  it("follows pagination for the user's installations", async () => {
    const installations = await client.listUserInstallations(USER_TOKEN);
    expect(installations.map((entry) => entry.id)).toEqual(
      fakeInstallations.map((entry) => entry.id),
    );
    expect(installations[2]).toMatchObject({
      targetType: "Organization",
      suspendedAt: null,
      account: { login: "account-3" },
    });
    expect(fake.requests).toHaveLength(2);
  });

  it("follows pagination for an installation's repositories", async () => {
    const repositories = await client.listInstallationRepositories(
      USER_TOKEN,
      7,
    );
    expect(repositories.map((entry) => entry.fullName)).toEqual(
      fakeRepositories.map((entry) => entry.full_name),
    );
    expect(repositories[1]).toMatchObject({ private: true, archived: false });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[0]?.url).toContain(
      "/user/installations/7/repositories",
    );
  });

  it("exchanges an OAuth code on the web URL with the caller's credentials", async () => {
    expect(await client.exchangeOAuthCode(app, "good-code")).toEqual({
      accessToken: "ghu_new_access_token_value",
      expiresInSeconds: 28800,
      refreshToken: "ghr_new_refresh_token_value",
      refreshTokenExpiresInSeconds: 15811200,
    });
    expect(fake.requests).toEqual([
      { method: "POST", url: `${FAKE_WEB_URL}/login/oauth/access_token` },
    ]);
  });

  it("refreshes a user token", async () => {
    const tokens = await client.refreshOAuthToken(app, "good-refresh");
    expect(tokens.accessToken).toBe("ghu_new_access_token_value");
  });

  it("converts a manifest code on the API URL", async () => {
    expect(await client.convertManifest("good-manifest-code")).toEqual({
      id: 42,
      slug: "crossboard-test",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      webhookSecret: "fake-webhook-secret-value",
      pem: expect.stringContaining("PRIVATE KEY"),
    });
    expect(fake.requests[0]?.url).toBe(
      `${FAKE_API_URL}/app-manifests/good-manifest-code/conversions`,
    );
  });
});

describe("only the D-18 credential exchanges are non-GET", () => {
  const NON_GET_CALLS: Record<string, string> = {
    exchangeOAuthCode: "POST",
    refreshOAuthToken: "POST",
    convertManifest: "POST",
    createInstallationToken: "POST",
    graphql: "POST",
  };

  const invoke: Record<string, (target: GithubClient) => Promise<unknown>> = {
    getUser: (target) => target.getUser(USER_TOKEN),
    listUserInstallations: (target) => target.listUserInstallations(USER_TOKEN),
    listInstallationRepositories: (target) =>
      target.listInstallationRepositories(USER_TOKEN, 7),
    exchangeOAuthCode: (target) => target.exchangeOAuthCode(app, "good-code"),
    refreshOAuthToken: (target) =>
      target.refreshOAuthToken(app, "good-refresh"),
    convertManifest: (target) => target.convertManifest("good-manifest-code"),
    createInstallationToken: (target) =>
      target.createInstallationToken(
        { appId: APP_ID, privateKey: APP_PRIVATE_KEY },
        INSTALLATION_ID,
      ),
    graphql: (target) =>
      target.graphql(issueInstallationToken(), queries.openIssuesPage, {
        owner: "octocat",
        name: "repo-1",
      }),
    restGet: (target) =>
      target.restGet(
        issueInstallationToken(),
        "GET /installation/repositories",
      ),
  };

  it("classifies every method the client exposes", () => {
    expect(Object.keys(invoke).sort()).toEqual(Object.keys(client).sort());
  });

  it.each(Object.keys(invoke))(
    "%s sends only the allowed method",
    async (name) => {
      await invoke[name]?.(client);
      const expected = NON_GET_CALLS[name] ?? "GET";
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(new Set(fake.requests.map((request) => request.method))).toEqual(
        new Set([expected]),
      );
    },
  );
});

describe("errors", () => {
  it("carries the status and GitHub's message, never the token", async () => {
    const error = await client
      .getUser("ghu_wrong_token")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect(error).toMatchObject({
      status: 401,
      githubMessage: "Bad credentials",
    });
    expect((error as Error).message).toBe(
      "GitHub responded 401: Bad credentials",
    );
    expect(JSON.stringify(error)).not.toContain("ghu_wrong_token");
    expect(String((error as Error).stack)).not.toContain("ghu_wrong_token");
  });

  it("reports a rejected OAuth code, which GitHub answers with 200", async () => {
    const error = await client
      .exchangeOAuthCode(app, "stale")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).githubMessage).toBe(
      "The code passed is incorrect or expired.",
    );
    expect((error as GithubError).code).toBe("bad_verification_code");
    expect((error as Error).message).not.toContain(CLIENT_SECRET);
  });

  it("reports an unknown manifest code", async () => {
    await expect(client.convertManifest("nope")).rejects.toMatchObject({
      status: 404,
      githubMessage: "Not Found",
    });
  });

  it("does not return a response of an unexpected shape as success", async () => {
    fake.server.use(
      http.get(`${FAKE_API_URL}/user`, () => HttpResponse.json({ nope: 1 })),
    );
    await expect(client.getUser(USER_TOKEN)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("reports a failure of a later page", async () => {
    fake.server.use(
      http.get(`${FAKE_API_URL}/user/installations`, ({ request }) =>
        new URL(request.url).searchParams.has("page")
          ? HttpResponse.json({ message: "Server Error" }, { status: 500 })
          : HttpResponse.json(
              { total_count: 3, installations: [fakeInstallations[0]] },
              {
                headers: {
                  link: `<${FAKE_API_URL}/user/installations?page=2>; rel="next"`,
                },
              },
            ),
      ),
    );
    await expect(
      client.listUserInstallations(USER_TOKEN),
    ).rejects.toMatchObject({
      status: 500,
      githubMessage: "Server Error",
    });
  });

  it("reports a network failure without leaking the request", async () => {
    fake.server.use(
      http.get(`${FAKE_API_URL}/user`, () => HttpResponse.error()),
    );
    const error = await client.getUser(USER_TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect(String((error as Error).message)).not.toContain(USER_TOKEN);
  });
});

describe("logging", () => {
  it("logs each call at debug without the token, credentials or body", async () => {
    await client.getUser(USER_TOKEN);
    await client.exchangeOAuthCode(app, "good-code");
    await client.convertManifest("good-manifest-code");
    await client.getUser("ghu_wrong_token").catch(() => undefined);

    const records = logs.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(
      records.map((record) => [record.level, record.route, record.status]),
    ).toEqual([
      [20, "GET /user", 200],
      [20, "POST /login/oauth/access_token", 200],
      [20, "POST /app-manifests/{code}/conversions", 201],
      [20, "GET /user", 401],
    ]);
    const output = logs.join("");
    for (const secret of [
      USER_TOKEN,
      "ghu_wrong_token",
      CLIENT_SECRET,
      "good-code",
      "good-manifest-code",
      "ghu_new_access_token_value",
      "ghr_new_refresh_token_value",
      "fake-webhook-secret-value",
      "octocat",
      "PRIVATE KEY",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
