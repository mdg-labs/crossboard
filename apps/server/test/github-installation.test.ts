import { readdirSync } from "node:fs";
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
import type { GithubAppCredentials } from "../src/config/index.js";
import {
  assertReadOnlyDocument,
  createGithubClient,
  createInstallationClient,
  GithubDocumentError,
  GithubError,
  INSTALLATION_TOKEN_REFRESH_MARGIN_MS,
  queries,
  type GithubClient,
  type GithubQuery,
  type InstallationClient,
} from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import {
  APP_ID,
  APP_PRIVATE_KEY,
  createFakeGithub,
  FAKE_API_URL,
  FAKE_WEB_URL,
  graphqlRequests,
  INSTALLATION_ID,
  installationTokens,
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
const variables = { owner: "octocat", name: "repo-1" };
const repo = "octocat/repo-1";

let logs: string[];
let github: GithubClient;
let clockOffset: number;
let current: GithubAppCredentials | null;
let client: InstallationClient;

beforeAll(() => fake.listen());
afterAll(() => fake.close());
beforeEach(() => {
  logs = [];
  clockOffset = 0;
  current = credentials;
  const logger = createLogger("debug", { write: (chunk) => logs.push(chunk) });
  github = createGithubClient({
    apiUrl: FAKE_API_URL,
    webUrl: FAKE_WEB_URL,
    logger,
  });
  client = createInstallationClient({
    github,
    credentials: () => current,
    logger,
    now: () => Date.now() + clockOffset,
  });
});
afterEach(() => fake.reset());

const tokenRequests = () =>
  fake.requests.filter((request) => request.url.endsWith("/access_tokens"));

describe("installation tokens", () => {
  it("creates a token from a JWT signed with the App's private key", async () => {
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables);
    expect(tokenRequests()).toEqual([
      {
        method: "POST",
        url: `${FAKE_API_URL}/app/installations/${String(INSTALLATION_ID)}/access_tokens`,
      },
    ]);
    expect(graphqlRequests[0]?.headers.authorization).toBe(
      `Bearer ${installationTokens.issued[0] ?? ""}`,
    );
  });

  it("reuses the token until 5 minutes before it expires, then renews it", async () => {
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables);
    await client.rest(INSTALLATION_ID, "GET /installation/repositories");
    clockOffset =
      installationTokens.ttlMs - INSTALLATION_TOKEN_REFRESH_MARGIN_MS - 60_000;
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables);
    expect(tokenRequests()).toHaveLength(1);

    clockOffset =
      installationTokens.ttlMs - INSTALLATION_TOKEN_REFRESH_MARGIN_MS + 1_000;
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables);
    expect(tokenRequests()).toHaveLength(2);
    expect(graphqlRequests.at(-1)?.headers.authorization).toBe(
      `Bearer ${installationTokens.issued[1] ?? ""}`,
    );
  });

  it("shares one token request between concurrent calls", async () => {
    await Promise.all([
      client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables),
      client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables),
      client.rest(INSTALLATION_ID, "GET /installation/repositories"),
    ]);
    expect(tokenRequests()).toHaveLength(1);
  });

  it("drops a token GitHub rejects, so the next call asks for a new one", async () => {
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables);
    installationTokens.revoked.add(installationTokens.issued[0] ?? "");
    await expect(
      client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables),
    ).rejects.toMatchObject({ status: 401 });
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables);
    expect(tokenRequests()).toHaveLength(2);
  });

  it("fails without a request when the App has no credentials", async () => {
    current = null;
    await expect(
      client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables),
    ).rejects.toThrow("no GitHub App credentials");
    expect(fake.requests).toEqual([]);
  });

  it("reports a private key that cannot sign without echoing it", async () => {
    current = { ...credentials, privateKey: "key-not-a-pem-sentinel" };
    const error = await client
      .graphql(INSTALLATION_ID, queries.openIssuesPage, variables)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("sentinel");
    expect(fake.requests).toEqual([]);
  });

  it("reports an installation GitHub does not know", async () => {
    await expect(
      client.graphql(8, queries.openIssuesPage, variables),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("never logs a token, the JWT or the private key", async () => {
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables, {
      repo,
    });
    await client.rest(
      INSTALLATION_ID,
      "GET /installation/repositories",
      {},
      {
        repo,
      },
    );
    installationTokens.revoked.add(installationTokens.issued[0] ?? "");
    await client
      .graphql(INSTALLATION_ID, queries.openIssuesPage, variables)
      .catch(() => undefined);
    await client.graphql(8, queries.openIssuesPage, variables).catch(() => {
      return undefined;
    });
    current = { ...credentials, privateKey: "key-not-a-pem-sentinel" };
    await client
      .graphql(9, queries.openIssuesPage, variables)
      .catch(() => undefined);

    const output = logs.join("");
    expect(output).toContain("github graphql");
    expect(installationTokens.issued.length).toBeGreaterThan(0);
    expect(installationTokens.jwts.length).toBeGreaterThan(0);
    for (const secret of [
      ...installationTokens.issued,
      ...installationTokens.jwts,
      "ghs_fake_installation_token",
      "BEGIN RSA PRIVATE KEY",
      "key-not-a-pem-sentinel",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe("GraphQL", () => {
  it("posts the document with its variables and sends no preview header", async () => {
    const data = await client.graphql(
      INSTALLATION_ID,
      queries.openIssuesPage,
      variables,
    );
    expect(data).toMatchObject({ rateLimit: { cost: 4 } });
    const sent = graphqlRequests[0];
    expect(sent?.body).toEqual({
      query: queries.openIssuesPage.document,
      variables,
    });
    for (const [name, value] of Object.entries(sent?.headers ?? {})) {
      expect(name).not.toMatch(/preview|graphql-features/i);
      expect(value).not.toMatch(/preview/i);
    }
  });

  it("logs the installation, repo and cost at debug", async () => {
    await client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables, {
      repo,
    });
    const record = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === "github graphql");
    expect(record).toMatchObject({
      level: 20,
      installationId: INSTALLATION_ID,
      repo,
      query: "OpenIssuesPage",
      cost: 4,
    });
  });

  it("answers GraphQL errors as a failure, not as data", async () => {
    fake.server.use(
      http.post(`${FAKE_API_URL}/graphql`, () =>
        HttpResponse.json({
          data: null,
          errors: [
            { type: "RATE_LIMITED", message: "API rate limit exceeded" },
          ],
        }),
      ),
    );
    const error = await client
      .graphql(INSTALLATION_ID, queries.openIssuesPage, variables)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect(error).toMatchObject({
      githubMessage: "API rate limit exceeded",
      code: "RATE_LIMITED",
    });
  });

  it("rejects a response of an unexpected shape", async () => {
    fake.server.use(
      http.post(`${FAKE_API_URL}/graphql`, () => HttpResponse.json([1])),
    );
    await expect(
      client.graphql(INSTALLATION_ID, queries.openIssuesPage, variables),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("REST", () => {
  it("runs a GET as the installation", async () => {
    const data = await client.rest(
      INSTALLATION_ID,
      "GET /installation/repositories",
    );
    expect(data).toMatchObject({ total_count: 1 });
  });

  it("refuses a route that is not a GET before sending anything", async () => {
    await expect(
      client.rest(
        INSTALLATION_ID,
        "POST /repos/octocat/repo-1/issues" as never,
        { title: "x" },
      ),
    ).rejects.toBeInstanceOf(GithubDocumentError);
    expect(fake.requests).toEqual([]);
    await expect(
      github.restGet("ghs_any", "DELETE /repos/octocat/repo-1" as never),
    ).rejects.toBeInstanceOf(GithubDocumentError);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ["method", { method: "PATCH", state: "closed" }],
    ["Method", { Method: "DELETE" }],
    ["url", { url: "/repos/octocat/repo-1" }],
    ["baseUrl", { baseUrl: "https://other.host" }],
    ["headers", { headers: { authorization: "Bearer other" } }],
    ["request", { request: { fetch: () => Promise.resolve() } }],
    ["mediaType", { mediaType: { previews: ["x"] } }],
  ])(
    "refuses the request option %s before sending anything",
    async (_, params) => {
      await expect(
        client.rest(INSTALLATION_ID, "GET /repos/{owner}/{repo}/issues", {
          owner: "octocat",
          repo: "repo-1",
          ...params,
        }),
      ).rejects.toBeInstanceOf(GithubDocumentError);
      await expect(
        github.restGet("ghs_any", "GET /repos/{owner}/{repo}/issues", {
          owner: "octocat",
          repo: "repo-1",
          ...params,
        }),
      ).rejects.toBeInstanceOf(GithubDocumentError);
      expect(fake.requests).toEqual([]);
    },
  );
});

describe("no mutation can be sent", () => {
  const refused = [
    [
      "a mutation",
      'mutation M { addStar(input: {starrableId: "x"}) { clientMutationId } }',
    ],
    [
      "a shorthand query followed by a mutation",
      "{ viewer { login } } mutation M { x }",
    ],
    [
      "a mutation after a query",
      "query Q { viewer { login } } mutation M { x }",
    ],
    [
      "a mutation after a fragment",
      "fragment F on User { login } mutation M { x }",
    ],
    ["a mutation behind a comment", "# query\nmutation M { x }"],
    ["a mutation behind a string-like comment", '# """\nmutation M { x }'],
    [
      "a mutation after a string holding braces",
      'query Q($a: String = "}") { x } mutation M { y }',
    ],
    [
      "a mutation after a block string",
      'query Q($a: String = """ } """) { x }\nmutation M { y }',
    ],
    [
      "a mutation after variable defaults with objects",
      "query Q($a: In = {b: 1}) { x } mutation M { y }",
    ],
    ["a subscription", "subscription S { x }"],
    ["an unnamed operation keyword in upper case", "Mutation M { x }"],
    ["a mutation with no space before the brace", "mutation{ x }"],
    ["an unbalanced document", "query Q { x"],
    ["an unterminated string", 'query Q { x(a: "oops) }'],
    ["an unterminated block string", 'query Q { x(a: """oops) }'],
    ["an empty document", "   # nothing\n"],
  ] as const;

  it.each(refused)("refuses %s", (_label, document) => {
    expect(() => assertReadOnlyDocument(document)).toThrow(GithubDocumentError);
  });

  const allowed = [
    ["a named query", "query Q($a: Int!) { x(a: $a) { y } }"],
    ["a shorthand query", "{ x }"],
    [
      "a query with a fragment",
      "query Q { ...F } fragment F on User { login }",
    ],
    ["a field named mutation", "query Q { mutation subscription }"],
    [
      "a string that mentions a mutation",
      'query Q { x(a: "mutation M { y }") }',
    ],
    [
      "a block string that mentions a mutation",
      'query Q { x(a: """\nmutation M { y }\n""") }',
    ],
    ["a comment that mentions a mutation", "query Q { x } # mutation M { y }"],
  ] as const;

  it.each(allowed)("accepts %s", (_label, document) => {
    expect(() => assertReadOnlyDocument(document)).not.toThrow();
  });

  it("sends nothing when the client is given a mutation", async () => {
    const mutation: GithubQuery = {
      name: "Star",
      document:
        'mutation Star { addStar(input: {starrableId: "x"}) { clientMutationId } }',
    };
    await expect(
      client.graphql(INSTALLATION_ID, mutation, {}),
    ).rejects.toBeInstanceOf(GithubDocumentError);
    await expect(
      github.graphql("ghs_any", mutation, {}),
    ).rejects.toBeInstanceOf(GithubDocumentError);
    expect(graphqlRequests).toEqual([]);
  });

  it("holds every document in queries/ to the check", async () => {
    const directory = new URL("../src/github/queries/", import.meta.url);
    const files = readdirSync(directory).filter(
      (file) => file.endsWith(".ts") && file !== "index.ts",
    );
    expect(files.length).toBeGreaterThan(0);
    const registered = new Set(Object.values(queries));
    for (const file of files) {
      const exported = (await import(new URL(file, directory).href)) as Record<
        string,
        GithubQuery
      >;
      const documents = Object.values(exported);
      expect(documents.length).toBeGreaterThan(0);
      for (const query of documents) {
        expect(query.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
        expect(query.document).toContain(`query ${query.name}`);
        expect(registered.has(query)).toBe(true);
        expect(() => assertReadOnlyDocument(query.document)).not.toThrow();
      }
    }
    for (const query of registered) {
      expect(() => assertReadOnlyDocument(query.document)).not.toThrow();
    }
  });
});
