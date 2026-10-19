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
import { http, HttpResponse } from "msw";
import type { GithubAppCredentials } from "../src/config/index.js";
import {
  BACKOFF_MS,
  createGithubClient,
  createInstallationClient,
  GithubError,
  queries,
  type GithubClient,
  type InstallationClient,
} from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  CLIENT_ID,
  CLIENT_SECRET,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
  graphqlRequests,
  INSTALLATION_ID,
} from "./github-fake.js";

const fake = createFakeGithub();
const credentials: GithubAppCredentials = {
  appId: APP_ID,
  appSlug: "crossboard",
  clientId: "Iv1.fake",
  clientSecret: "fake-client-secret-value",
  privateKey: APP_PRIVATE_KEY,
  webhookSecret: "fake-webhook-secret-value",
};

const NOW = 1_000_000_000_000;
const RESET_SECONDS = NOW / 1000 + 3_600;
const ISSUES = `${FAKE_API_URL}/repos/octocat/repo-1/issues`;
const issuesRoute = "GET /repos/{owner}/{repo}/issues";
const issuesParams = { owner: "octocat", repo: "repo-1" };
const repo = "octocat/repo-1";

let logs: string[];
let sleeps: number[];
let github: GithubClient;
let client: InstallationClient;

beforeAll(() => fake.listen());
afterAll(() => fake.close());
beforeEach(() => {
  logs = [];
  sleeps = [];
  const logger = createLogger("debug", { write: (chunk) => logs.push(chunk) });
  github = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    logger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => NOW,
  });
  client = createInstallationClient({
    github,
    credentials: () => credentials,
  });
});
afterEach(() => fake.reset());

const rateHeaders = (remaining: number) => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(RESET_SECONDS),
});

const getIssues = () =>
  client.rest(INSTALLATION_ID, issuesRoute, issuesParams, { repo });

/** Answers `statuses` in turn, then 200 once they run out. */
function answer(
  statuses: { status: number; headers?: Record<string, string> }[],
) {
  const seen: Request[] = [];
  fake.server.use(
    http.get(ISSUES, ({ request }) => {
      seen.push(request);
      const next = statuses[seen.length - 1];
      return next === undefined
        ? HttpResponse.json([], { headers: rateHeaders(10) })
        : HttpResponse.json({ message: "nope" }, next);
    }),
  );
  return seen;
}

/** Holds each request to `ISSUES` until released and counts what is in flight. */
function hold() {
  const waiting: (() => void)[] = [];
  const byToken = new Map<string, number>();
  const state = { inFlight: 0, peak: 0, peakPerToken: 0 };
  fake.server.use(
    http.get(ISSUES, async ({ request }) => {
      const token = request.headers.get("authorization") ?? "";
      byToken.set(token, (byToken.get(token) ?? 0) + 1);
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      state.peakPerToken = Math.max(state.peakPerToken, ...byToken.values());
      await new Promise<void>((resolve) => waiting.push(resolve));
      state.inFlight--;
      byToken.set(token, (byToken.get(token) ?? 1) - 1);
      return HttpResponse.json([]);
    }),
  );
  return {
    state,
    releaseAll() {
      for (const release of waiting.splice(0)) release();
    },
  };
}

async function drain(
  calls: Promise<unknown>[],
  releaseAll: () => void,
): Promise<void> {
  let settled = false;
  void Promise.allSettled(calls).then(() => {
    settled = true;
  });
  const deadline = Date.now() + 4_000;
  while (!settled && Date.now() < deadline) {
    releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(settled).toBe(true);
}

describe("budget tracking", () => {
  it("is unknown until the first call", () => {
    expect(github.budgets.get(INSTALLATION_ID)).toEqual({
      rest: null,
      graphql: null,
    });
    expect(client.budgets.get(INSTALLATION_ID)).toEqual({
      rest: null,
      graphql: null,
    });
  });

  it("reads the REST budget from the response headers", async () => {
    answer([]);
    await getIssues();
    expect(client.budgets.get(INSTALLATION_ID)).toEqual({
      rest: { remaining: 10, limit: 5000, resetAt: RESET_SECONDS * 1000 },
      graphql: null,
    });
  });

  it("reads the GraphQL budget from rateLimit, over the headers", async () => {
    fake.server.use(
      http.post(`${FAKE_API_URL}/graphql`, () =>
        HttpResponse.json(
          {
            data: {
              rateLimit: {
                cost: 4,
                limit: 12_500,
                remaining: 12_000,
                resetAt: new Date(RESET_SECONDS * 1000).toISOString(),
              },
            },
          },
          { headers: rateHeaders(9_999) },
        ),
      ),
    );
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, {
      owner: "octocat",
      name: "repo-1",
    });
    expect(client.budgets.get(INSTALLATION_ID)).toEqual({
      rest: null,
      graphql: {
        remaining: 12_000,
        limit: 12_500,
        resetAt: RESET_SECONDS * 1000,
      },
    });
  });

  it("keeps REST and GraphQL separate and each installation apart", async () => {
    answer([]);
    await getIssues();
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, {
      owner: "octocat",
      name: "repo-1",
    });
    await github.restGet("any-token", issuesRoute, issuesParams, {
      installationId: 99,
    });
    expect(client.budgets.get(INSTALLATION_ID)).toMatchObject({
      rest: { remaining: 10 },
      graphql: { remaining: 4996 },
    });
    expect(client.budgets.get(99)).toMatchObject({
      rest: { remaining: 10 },
      graphql: null,
    });
    expect(client.budgets.get(100)).toEqual({ rest: null, graphql: null });
  });

  it("books nothing for a call made without an installation", async () => {
    answer([]);
    await github.restGet("any-token", issuesRoute, issuesParams);
    expect(github.budgets.get(INSTALLATION_ID).rest).toBeNull();
  });

  it("learns the budget from an error answer as well", async () => {
    answer([{ status: 404, headers: rateHeaders(123) }]);
    await expect(getIssues()).rejects.toMatchObject({ status: 404 });
    expect(client.budgets.get(INSTALLATION_ID).rest).toEqual({
      remaining: 123,
      limit: 5000,
      resetAt: RESET_SECONDS * 1000,
    });
  });
});

describe("concurrency", () => {
  it("runs at most 2 requests of one installation at a time", async () => {
    const held = hold();
    const calls = Array.from({ length: 6 }, getIssues);
    await vi.waitFor(() => expect(held.state.inFlight).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.state.inFlight).toBe(2);
    await drain(calls, held.releaseAll);
    expect(held.state.peak).toBe(2);
  });

  it("runs at most 4 requests at a time across installations", async () => {
    const held = hold();
    const calls = [1, 2, 3].flatMap((installationId) =>
      Array.from({ length: 3 }, () =>
        github.restGet(
          `tok-${String(installationId)}`,
          issuesRoute,
          issuesParams,
          { installationId },
        ),
      ),
    );
    await vi.waitFor(() => expect(held.state.inFlight).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.state.inFlight).toBe(4);
    await drain(calls, held.releaseAll);
    expect(held.state.peak).toBe(4);
    expect(held.state.peakPerToken).toBe(2);
  });

  it("counts calls made without an installation toward the 4 overall", async () => {
    const held = hold();
    const calls = Array.from({ length: 7 }, (_, index) =>
      github.restGet(`user-${String(index)}`, issuesRoute, issuesParams),
    );
    await vi.waitFor(() => expect(held.state.inFlight).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.state.inFlight).toBe(4);
    await drain(calls, held.releaseAll);
    expect(held.state.peak).toBe(4);
  });

  it("frees the slot of a call that fails", async () => {
    const held = hold();
    const calls = Array.from({ length: 5 }, getIssues);
    await vi.waitFor(() => expect(held.state.inFlight).toBe(2));
    fake.server.use(
      http.get(ISSUES, () =>
        HttpResponse.json({ message: "x" }, { status: 404 }),
      ),
    );
    held.releaseAll();
    const results = await Promise.allSettled(calls);
    expect(results.map((result) => result.status).slice(0, 2)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(results.slice(2).every((r) => r.status === "rejected")).toBe(true);
  });
});

describe("waiting for a reported limit", () => {
  it("waits for retry-after on a 429, then retries", async () => {
    const seen = answer([{ status: 429, headers: { "retry-after": "7" } }]);
    await getIssues();
    expect(sleeps).toEqual([7_000]);
    expect(seen).toHaveLength(2);
  });

  it("waits until x-ratelimit-reset on a 403 with the budget spent", async () => {
    const seen = answer([
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(NOW / 1000 + 42),
        },
      },
    ]);
    await getIssues();
    expect(sleeps).toEqual([42_000]);
    expect(seen).toHaveLength(2);
  });

  it("prefers retry-after to x-ratelimit-reset", async () => {
    answer([
      {
        status: 403,
        headers: {
          "retry-after": "3",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(NOW / 1000 + 42),
        },
      },
    ]);
    await getIssues();
    expect(sleeps).toEqual([3_000]);
  });

  it("treats a 403 that leaves budget as an ordinary failure", async () => {
    const seen = answer(
      Array.from({ length: 4 }, () => ({
        status: 403,
        headers: rateHeaders(4_000),
      })),
    );
    await expect(getIssues()).rejects.toMatchObject({ status: 403 });
    expect(sleeps).toEqual([...BACKOFF_MS]);
    expect(seen).toHaveLength(4);
  });

  it("gives up after waiting three times", async () => {
    const seen = answer(
      Array.from({ length: 5 }, () => ({
        status: 429,
        headers: { "retry-after": "2" },
      })),
    );
    await expect(getIssues()).rejects.toMatchObject({ status: 429 });
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(seen).toHaveLength(4);
  });
});

describe("waiting for a limited GraphQL answer", () => {
  const GRAPHQL = `${FAKE_API_URL}/graphql`;
  const limited = {
    data: null,
    errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
  };
  const openIssuesPage = () =>
    client.graphql(INSTALLATION_ID, queries.openIssuesPage, {
      owner: "octocat",
      name: "repo-1",
    });

  /** Answers GraphQL with `answers` in turn, then with the real fake. */
  function answerGraphql(answers: (() => Response)[]) {
    let calls = 0;
    fake.server.use(http.post(GRAPHQL, () => answers[calls++]?.()));
    return () => calls;
  }

  it("waits until x-ratelimit-reset after RATE_LIMITED, then retries", async () => {
    const calls = answerGraphql([
      () =>
        HttpResponse.json(limited, {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(NOW / 1000 + 42),
          },
        }),
    ]);
    await openIssuesPage();
    expect(sleeps).toEqual([42_000]);
    expect(calls()).toBe(2);
  });

  it("falls back to rateLimit.resetAt in the body", async () => {
    answerGraphql([
      () =>
        HttpResponse.json({
          ...limited,
          data: {
            rateLimit: {
              remaining: 0,
              resetAt: new Date(NOW + 9_000).toISOString(),
            },
          },
        }),
    ]);
    await openIssuesPage();
    expect(sleeps).toEqual([9_000]);
  });

  it("gives up after waiting three times", async () => {
    const answer = () =>
      HttpResponse.json(limited, {
        headers: { "x-ratelimit-reset": String(NOW / 1000 + 2) },
      });
    const calls = answerGraphql(Array.from({ length: 5 }, () => answer));
    await expect(openIssuesPage()).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(calls()).toBe(4);
  });

  it("does not wait after another GraphQL error", async () => {
    const calls = answerGraphql([
      () =>
        HttpResponse.json({
          errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
        }),
    ]);
    await expect(openIssuesPage()).rejects.toBeInstanceOf(GithubError);
    expect(sleeps).toEqual([]);
    expect(calls()).toBe(1);
  });
});

describe("retrying other failures", () => {
  it("backs off 1 s, 4 s and 16 s, then throws", async () => {
    const seen = answer(Array.from({ length: 5 }, () => ({ status: 500 })));
    const error = await getIssues().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect(error).toMatchObject({ status: 500, githubMessage: "nope" });
    expect(sleeps).toEqual([1_000, 4_000, 16_000]);
    expect(seen).toHaveLength(4);
  });

  it("returns the answer of a retry that succeeds", async () => {
    const seen = answer([{ status: 502 }, { status: 503 }]);
    expect(await getIssues()).toEqual([]);
    expect(sleeps).toEqual([1_000, 4_000]);
    expect(seen).toHaveLength(3);
  });

  it("retries a network failure", async () => {
    let calls = 0;
    fake.server.use(
      http.get(ISSUES, () =>
        ++calls === 1 ? HttpResponse.error() : HttpResponse.json([]),
      ),
    );
    expect(await getIssues()).toEqual([]);
    expect(sleeps).toEqual([1_000]);
  });

  it("does not retry an answer that would not change", async () => {
    const seen = answer([{ status: 404 }]);
    await expect(getIssues()).rejects.toMatchObject({ status: 404 });
    expect(sleeps).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});

describe("single-use exchanges", () => {
  const app = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
  const OAUTH = `${FAKE_WEB_URL}/login/oauth/access_token`;

  /** Answers the OAuth endpoint with `failures` in turn, then the real fake. */
  function failOAuth(failures: (() => Response)[]) {
    const seen: Request[] = [];
    fake.server.use(
      http.post(OAUTH, ({ request }) => {
        seen.push(request);
        return failures[seen.length - 1]?.();
      }),
    );
    return seen;
  }

  it("does not retry a refresh after a server error", async () => {
    const seen = failOAuth([
      () => HttpResponse.json({ message: "nope" }, { status: 502 }),
    ]);
    await expect(
      github.refreshOAuthToken(app, "good-refresh"),
    ).rejects.toMatchObject({ status: 502 });
    expect(sleeps).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("does not retry a code exchange after a network failure", async () => {
    const seen = failOAuth([() => HttpResponse.error()]);
    await expect(
      github.exchangeOAuthCode(app, "good-code"),
    ).rejects.toBeInstanceOf(GithubError);
    expect(sleeps).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("does not retry a manifest conversion after a server error", async () => {
    let calls = 0;
    fake.server.use(
      http.post(`${FAKE_API_URL}/app-manifests/:code/conversions`, () => {
        calls++;
        return HttpResponse.json({ message: "nope" }, { status: 500 });
      }),
    );
    await expect(
      github.convertManifest("good-manifest-code"),
    ).rejects.toMatchObject({ status: 500 });
    expect(sleeps).toEqual([]);
    expect(calls).toBe(1);
  });

  it("still waits for a reported limit, then sends the exchange again", async () => {
    const seen = failOAuth([
      () =>
        HttpResponse.json(
          { message: "slow down" },
          { status: 429, headers: { "retry-after": "5" } },
        ),
    ]);
    const tokens = await github.refreshOAuthToken(app, "good-refresh");
    expect(tokens.accessToken).toBe("ghu_new_access_token_value");
    expect(sleeps).toEqual([5_000]);
    expect(seen).toHaveLength(2);
  });
});

describe("conditional requests", () => {
  const route = "GET /repos/{owner}/{repo}/issues" as const;

  function etagged() {
    const sent: (string | null)[] = [];
    fake.server.use(
      http.get(ISSUES, ({ request }) => {
        const etag = request.headers.get("if-none-match");
        sent.push(etag);
        return etag === '"v1"'
          ? new HttpResponse(null, { status: 304, headers: rateHeaders(7) })
          : HttpResponse.json([{ number: 1 }], {
              headers: { etag: '"v1"', ...rateHeaders(8) },
            });
      }),
    );
    return sent;
  }

  it("sends If-None-Match and returns a 304 as not modified", async () => {
    const sent = etagged();
    expect(
      await client.restConditional(
        INSTALLATION_ID,
        route,
        '"v1"',
        issuesParams,
        {
          repo,
        },
      ),
    ).toEqual({ notModified: true });
    expect(sent).toEqual(['"v1"']);
    expect(sleeps).toEqual([]);
    expect(client.budgets.get(INSTALLATION_ID).rest?.remaining).toBe(7);
  });

  it("returns the body and the new ETag when the resource changed", async () => {
    etagged();
    expect(
      await client.restConditional(
        INSTALLATION_ID,
        route,
        '"old"',
        issuesParams,
      ),
    ).toEqual({ notModified: false, data: [{ number: 1 }], etag: '"v1"' });
  });

  it("sends no If-None-Match on a plain GET and refuses a 304 there", async () => {
    const sent = etagged();
    await getIssues();
    expect(sent).toEqual([null]);
    fake.server.use(
      http.get(ISSUES, () => new HttpResponse(null, { status: 304 })),
    );
    await expect(getIssues()).rejects.toMatchObject({ status: 304 });
  });

  it("refuses a route that is not a GET before sending anything", async () => {
    await expect(
      client.restConditional(
        INSTALLATION_ID,
        "POST /repos/octocat/repo-1/issues" as never,
        '"v1"',
      ),
    ).rejects.toThrow("only GET routes");
    expect(fake.requests).toEqual([]);
  });
});

describe("logging", () => {
  it("logs every call at debug with installation, repo, cost and remaining budget", async () => {
    answer([]);
    await getIssues();
    await client.graphql(
      INSTALLATION_ID,
      queries.openIssuesPage,
      { owner: "octocat", name: "repo-1" },
      { repo },
    );
    const records = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (record) =>
          record.msg === "github request" &&
          record.installationId !== undefined,
      );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 20,
      route: issuesRoute,
      installationId: INSTALLATION_ID,
      repo,
      status: 200,
      cost: 1,
      remaining: 10,
    });
    expect(records[1]).toMatchObject({
      route: "POST /graphql",
      query: "OpenIssuesPage",
      installationId: INSTALLATION_ID,
      repo,
      cost: 4,
      remaining: 4996,
    });
    expect(graphqlRequests).toHaveLength(1);
  });

  it("logs a failed attempt and when it will be retried", async () => {
    answer([{ status: 500 }]);
    await getIssues();
    const failed = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === "github request failed");
    expect(failed).toMatchObject({
      installationId: INSTALLATION_ID,
      repo,
      status: 500,
      attempt: 1,
      retryInMs: 1_000,
    });
  });
});
