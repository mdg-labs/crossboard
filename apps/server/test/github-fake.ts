import { createVerify, generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const FAKE_API_URL = "https://api.github.test";
export const FAKE_WEB_URL = "https://github.test";

export const USER_TOKEN = "ghu_fake_user_token_value";
export const CLIENT_ID = "Iv1.fakeclient";
export const CLIENT_SECRET = "fake-client-secret-value";

export const fakeUser = {
  id: 583231,
  login: "octocat",
  name: "The Octocat",
  avatar_url: "https://avatars.githubusercontent.com/u/583231",
};

export const APP_ID = "99";
const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const APP_PRIVATE_KEY = appKeys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();

export const INSTALLATION_ID = 7;
const INSTALLATION_TOKEN_PREFIX = "ghs_fake_installation_token_";

/** Controls the installation token endpoint; `reset` restores the defaults. */
export const installationTokens = {
  issued: [] as string[],
  revoked: new Set<string>(),
  ttlMs: 60 * 60 * 1000,
  jwts: [] as string[],
};

export function issueInstallationToken(): string {
  const token = `${INSTALLATION_TOKEN_PREFIX}${String(installationTokens.issued.length + 1)}`;
  installationTokens.issued.push(token);
  return token;
}

/** Each GraphQL request the fake received. */
export const graphqlRequests: {
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}[] = [];

const PAGE_SIZE = 2;

export const fakeInstallations = [1, 2, 3].map((id) => ({
  id,
  app_id: 99,
  target_type: id === 3 ? "Organization" : "User",
  account: { id: 100 + id, login: `account-${String(id)}`, type: "User" },
  suspended_at: null,
  repository_selection: "all",
}));

export const fakeRepositories = [1, 2, 3, 4, 5].map((id) => ({
  id,
  node_id: `R_${String(id)}`,
  name: `repo-${String(id)}`,
  full_name: `octocat/repo-${String(id)}`,
  owner: { id: 583231, login: "octocat" },
  private: id % 2 === 0,
  archived: false,
  has_issues: true,
}));

export const fakeOAuthTokens = {
  access_token: "ghu_new_access_token_value",
  expires_in: 28800,
  refresh_token: "ghr_new_refresh_token_value",
  refresh_token_expires_in: 15811200,
  token_type: "bearer",
  scope: "",
};

export const fakeManifestApp = {
  id: 42,
  slug: "crossboard-test",
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  webhook_secret: "fake-webhook-secret-value",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
};

function authorized(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${USER_TOKEN}`;
}

const badCredentials = () =>
  HttpResponse.json({ message: "Bad credentials" }, { status: 401 });

/** True for a JWT signed by the fake App's key, issued for it and live for at most 10 minutes. */
function validAppJwt(request: Request): boolean {
  const [scheme, jwt] = (request.headers.get("authorization") ?? "").split(" ");
  const [header, payload, signature] = (jwt ?? "").split(".");
  if (scheme !== "Bearer" || !header || !payload || !signature) return false;
  const verified = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(appKeys.publicKey, Buffer.from(signature, "base64url"));
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { iss: string; iat: number; exp: number };
  const now = Date.now() / 1000;
  installationTokens.jwts.push(jwt ?? "");
  return (
    verified &&
    JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg ===
      "RS256" &&
    claims.iss === APP_ID &&
    claims.iat <= now &&
    claims.exp > now &&
    claims.exp - claims.iat <= 10 * 60
  );
}

function installationAuthorized(request: Request): boolean {
  const token = (request.headers.get("authorization") ?? "").replace(
    "Bearer ",
    "",
  );
  return (
    installationTokens.issued.includes(token) &&
    !installationTokens.revoked.has(token)
  );
}

function paged(request: Request, key: string, items: unknown[]) {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const headers: Record<string, string> = {};
  if (page * PAGE_SIZE < items.length) {
    url.searchParams.set("page", String(page + 1));
    headers.link = `<${url.toString()}>; rel="next"`;
  }
  return HttpResponse.json(
    { total_count: items.length, [key]: slice },
    { headers },
  );
}

export const githubHandlers = [
  http.get(`${FAKE_API_URL}/user`, ({ request }) =>
    authorized(request) ? HttpResponse.json(fakeUser) : badCredentials(),
  ),
  http.get(`${FAKE_API_URL}/user/installations`, ({ request }) =>
    authorized(request)
      ? paged(request, "installations", fakeInstallations)
      : badCredentials(),
  ),
  http.get(
    `${FAKE_API_URL}/user/installations/:installationId/repositories`,
    ({ request, params }) => {
      if (!authorized(request)) return badCredentials();
      if (params.installationId !== "7") {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return paged(request, "repositories", fakeRepositories);
    },
  ),
  http.post(`${FAKE_WEB_URL}/login/oauth/access_token`, async ({ request }) => {
    const body = (await request.json()) as Record<string, string>;
    const valid =
      body.client_id === CLIENT_ID &&
      body.client_secret === CLIENT_SECRET &&
      (body.code === "good-code" ||
        (body.grant_type === "refresh_token" &&
          body.refresh_token === "good-refresh"));
    if (valid) return HttpResponse.json(fakeOAuthTokens);
    return body.grant_type === "refresh_token"
      ? HttpResponse.json({
          error: "bad_refresh_token",
          error_description:
            "The refresh token passed is incorrect or expired.",
        })
      : HttpResponse.json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        });
  }),
  http.post(
    `${FAKE_API_URL}/app/installations/:installationId/access_tokens`,
    ({ request, params }) => {
      if (!validAppJwt(request)) {
        return HttpResponse.json(
          { message: "A JSON web token could not be decoded" },
          { status: 401 },
        );
      }
      if (params.installationId !== String(INSTALLATION_ID)) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const token = issueInstallationToken();
      return HttpResponse.json(
        {
          token,
          expires_at: new Date(
            Date.now() + installationTokens.ttlMs,
          ).toISOString(),
        },
        { status: 201 },
      );
    },
  ),
  http.post(`${FAKE_API_URL}/graphql`, async ({ request }) => {
    graphqlRequests.push({
      headers: Object.fromEntries(request.headers.entries()),
      body: (await request.clone().json()) as never,
    });
    if (!installationAuthorized(request)) return badCredentials();
    return HttpResponse.json({
      data: {
        rateLimit: { cost: 4, remaining: 4996 },
        repository: { issues: { totalCount: 0, nodes: [] } },
      },
    });
  }),
  http.get(`${FAKE_API_URL}/installation/repositories`, ({ request }) =>
    installationAuthorized(request)
      ? HttpResponse.json({
          total_count: 1,
          repositories: [fakeRepositories[0]],
        })
      : badCredentials(),
  ),
  http.post(`${FAKE_API_URL}/app-manifests/:code/conversions`, ({ params }) =>
    params.code === "good-manifest-code"
      ? HttpResponse.json(fakeManifestApp, { status: 201 })
      : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
];

/**
 * An msw server that answers GitHub's REST and OAuth endpoints. Any request it
 * has no handler for fails the test, so nothing reaches the real GitHub.
 */
export function createFakeGithub() {
  const server = setupServer(...githubHandlers);
  const requests: { method: string; url: string }[] = [];
  server.events.on("request:start", ({ request }) => {
    requests.push({ method: request.method, url: request.url });
  });
  return {
    server,
    requests,
    listen: () => server.listen({ onUnhandledFrame: "error" }),
    reset: () => {
      requests.length = 0;
      graphqlRequests.length = 0;
      installationTokens.issued.length = 0;
      installationTokens.jwts.length = 0;
      installationTokens.revoked.clear();
      installationTokens.ttlMs = 60 * 60 * 1000;
      server.resetHandlers();
    },
    close: () => server.close(),
  };
}
