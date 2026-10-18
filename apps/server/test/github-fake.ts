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
    return valid
      ? HttpResponse.json(fakeOAuthTokens)
      : HttpResponse.json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        });
  }),
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
      server.resetHandlers();
    },
    close: () => server.close(),
  };
}
