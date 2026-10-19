import { createSign } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";
import { Octokit, RequestError } from "octokit";
import type { Logger } from "pino";
import { z } from "zod";
import { GithubError } from "./errors.js";
import {
  BACKOFF_MS,
  budgetFromHeaders,
  createBudgetStore,
  createSemaphore,
  MAX_LIMIT_WAITS,
  MAX_REQUESTS_OVERALL,
  MAX_REQUESTS_PER_INSTALLATION,
  rateLimitFromGraphql,
  waitMsFromHeaders,
  type GithubBudgets,
  type RateResource,
  type ResponseHeaders,
  type Semaphore,
} from "./rate-limit.js";
import {
  assertGetRoute,
  assertReadOnlyDocument,
  type GithubQuery,
} from "./query.js";

export interface GithubClientOptions {
  /** `config.githubApiUrl` */
  apiUrl: string;
  /** `config.githubWebUrl` */
  webUrl: string;
  logger: Logger;
  /** Waits between attempts; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Which installation and repository a call is made for; logged, and the budget it reports is booked to the installation. */
export interface GithubRequestMeta {
  installationId?: number;
  /** `owner/name` */
  repo?: string;
}

/** The answer to a conditional REST `GET`. */
export type GithubConditionalResult =
  | { notModified: true }
  | { notModified: false; data: unknown; etag: string | null };

/** The App's OAuth credentials; the caller owns them, the client never reads config. */
export interface GithubOAuthApp {
  clientId: string;
  clientSecret: string;
}

/** What signs the App's JWT; the caller owns it, the client never reads config. */
export interface GithubAppKey {
  appId: string;
  privateKey: string;
}

export interface GithubInstallationToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A REST route the server may call with an installation token. */
export type GithubGetRoute = `GET ${string}`;

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GithubInstallation {
  id: number;
  appId: number;
  targetType: string;
  account: { id: number; login: string; type: string } | null;
  suspendedAt: string | null;
  repositorySelection: string;
}

export interface GithubRepository {
  id: number;
  nodeId: string;
  name: string;
  fullName: string;
  owner: { id: number; login: string };
  private: boolean;
  archived: boolean;
  hasIssues: boolean;
}

export interface GithubOAuthTokens {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
}

export interface GithubManifestConversion {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
}

/**
 * The one place that talks to GitHub. Every method is a `GET` except the
 * credential exchanges D-18 allows (the OAuth code exchange and refresh, the
 * manifest conversion, installation access tokens) and `graphql`, which
 * refuses any document that is not a query.
 */
export interface GithubClient {
  /**
   * What each installation has left, as reported by the responses the client
   * has received since the process started.
   */
  readonly budgets: GithubBudgets;
  getUser(token: string): Promise<GithubUser>;
  listUserInstallations(token: string): Promise<GithubInstallation[]>;
  listInstallationRepositories(
    token: string,
    installationId: number,
  ): Promise<GithubRepository[]>;
  exchangeOAuthCode(
    app: GithubOAuthApp,
    code: string,
    redirectUri?: string,
  ): Promise<GithubOAuthTokens>;
  refreshOAuthToken(
    app: GithubOAuthApp,
    refreshToken: string,
  ): Promise<GithubOAuthTokens>;
  convertManifest(code: string): Promise<GithubManifestConversion>;
  /** Exchanges the App's signed JWT for an installation access token (D-4). */
  createInstallationToken(
    app: GithubAppKey,
    installationId: number,
  ): Promise<GithubInstallationToken>;
  /**
   * Sends one GraphQL query with a token and returns the response's `data`.
   * Sends no preview header. Throws GithubDocumentError, without any request,
   * for a document that holds anything but queries and fragments, and
   * GithubError when GitHub answers with errors.
   */
  graphql(
    token: string,
    query: GithubQuery,
    variables?: Record<string, unknown>,
    meta?: GithubRequestMeta,
  ): Promise<unknown>;
  /** Sends one REST `GET` with a token and returns the response body. */
  restGet(
    token: string,
    route: GithubGetRoute,
    params?: Record<string, unknown>,
    meta?: GithubRequestMeta,
  ): Promise<unknown>;
  /**
   * Sends one REST `GET` with `If-None-Match: <etag>`. A `304` comes back as
   * `{ notModified: true }`; any other success carries the body and the new ETag.
   */
  restGetConditional(
    token: string,
    route: GithubGetRoute,
    etag: string,
    params?: Record<string, unknown>,
    meta?: GithubRequestMeta,
  ): Promise<GithubConditionalResult>;
}

const userSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

const accountSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const installationSchema = z.object({
  id: z.number(),
  app_id: z.number(),
  target_type: z.string(),
  account: accountSchema.nullable().optional(),
  suspended_at: z.string().nullable().optional(),
  repository_selection: z.string(),
});

const repositorySchema = z.object({
  id: z.number(),
  node_id: z.string(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ id: z.number(), login: z.string() }),
  private: z.boolean(),
  archived: z.boolean().optional(),
  has_issues: z.boolean().optional(),
});

const oauthSuccessSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number(),
});

const oauthFailureSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const manifestSchema = z.object({
  id: z.number(),
  slug: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  webhook_secret: z.string(),
  pem: z.string(),
});

const installationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
});

const graphqlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
});

/** GitHub caps the App JWT's lifetime at 10 minutes and tolerates clock drift of a minute. */
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signAppJwt(app: GithubAppKey): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(
      JSON.stringify({
        iat: issuedAt - JWT_BACKDATE_SECONDS,
        exp: issuedAt + JWT_LIFETIME_SECONDS,
        iss: app.appId,
      }),
    ),
  ].join(".");
  try {
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(app.privateKey);
    return `${unsigned}.${base64url(signature)}`;
  } catch {
    throw new Error("the GitHub App private key cannot sign a JWT");
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new GithubError(502, `unexpected ${what} response`);
  }
  return result.data;
}

function messageOf(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && "message" in data) {
    const { message } = data;
    if (typeof message === "string" && message !== "") return message;
  }
  return undefined;
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const { logger } = options;
  const octokit = new Octokit({
    baseUrl: options.apiUrl,
    userAgent: "crossboard",
    // Rate-limit handling belongs to the central client, not to the plugins.
    throttle: { enabled: false },
    retry: { enabled: false },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
    },
  });

  const sleep =
    options.sleep ?? ((ms: number) => sleepFor(ms, undefined, { ref: false }));
  const now = options.now ?? Date.now;
  const budgets = createBudgetStore();
  const overall = createSemaphore(MAX_REQUESTS_OVERALL);
  const perInstallation = new Map<number, Semaphore>();

  function gateFor(installationId: number): Semaphore {
    let gate = perInstallation.get(installationId);
    if (gate === undefined) {
      gate = createSemaphore(MAX_REQUESTS_PER_INSTALLATION);
      perInstallation.set(installationId, gate);
    }
    return gate;
  }

  interface Sent<T> {
    status: number;
    data: T;
    headers?: ResponseHeaders;
  }

  interface CallInfo extends GithubRequestMeta {
    resource?: RateResource;
    /** The name of the GraphQL query. */
    query?: string;
    /** A `304` is an answer, not a failure. */
    conditional?: boolean;
    /**
     * False for single-use exchanges (an OAuth code or refresh token, a
     * manifest code): GitHub may have consumed it before the answer was lost,
     * so a retry would replay it. Rate-limit waits still apply, since GitHub
     * did not process a request it limited.
     */
    retry?: boolean;
  }

  /**
   * Every request goes through here. It holds at most 2 requests in flight
   * per installation and 4 overall, books the budget the response reports to
   * the installation, waits as GitHub says after a rate-limit `403`/`429`,
   * and retries other transient failures after 1 s, 4 s and 16 s unless
   * `retry` is false. It logs the
   * route template and the outcome at `debug` (never a token, URL parameter
   * or body) and turns a failure into a GithubError that carries status and
   * GitHub's message only.
   */
  async function call<T>(
    route: string,
    send: () => Promise<Sent<T>>,
    info: CallInfo = {},
  ): Promise<Sent<T>> {
    const { installationId, repo, resource } = info;
    const attemptOnce = () => overall.run(send);
    const gate =
      installationId === undefined ? undefined : gateFor(installationId);
    const limited =
      gate === undefined ? attemptOnce : () => gate.run(attemptOnce);

    const book = (
      headers: ResponseHeaders,
      body: unknown,
    ): { cost?: number; remaining?: number } => {
      const fromHeaders = budgetFromHeaders(headers);
      const fromBody =
        resource === "graphql" ? rateLimitFromGraphql(body) : undefined;
      if (installationId !== undefined && resource !== undefined) {
        if (fromHeaders !== undefined) {
          budgets.update(installationId, resource, fromHeaders);
        }
        if (fromBody?.budget !== undefined) {
          budgets.update(installationId, resource, fromBody.budget);
        }
      }
      const remaining = fromBody?.budget?.remaining ?? fromHeaders?.remaining;
      return {
        ...(fromBody?.cost === undefined ? {} : { cost: fromBody.cost }),
        ...(remaining === undefined ? {} : { remaining }),
      };
    };

    let retries = 0;
    let limitWaits = 0;
    for (let attempt = 1; ; attempt++) {
      const started = now();
      try {
        const response = await limited();
        const headers = response.headers ?? {};
        const booked = book(headers, response.data);
        logger.debug(
          {
            route,
            query: info.query,
            installationId,
            repo,
            status: response.status,
            attempt,
            cost: booked.cost ?? (resource === "rest" ? 1 : undefined),
            remaining: booked.remaining,
            durationMs: now() - started,
          },
          "github request",
        );
        return { ...response, headers };
      } catch (error) {
        const failure = error instanceof RequestError ? error : undefined;
        const status = failure?.status;
        const headers = (failure?.response?.headers ?? {}) as ResponseHeaders;
        const booked = book(headers, undefined);
        if (info.conditional === true && status === 304) {
          logger.debug(
            {
              route,
              installationId,
              repo,
              status,
              attempt,
              cost: 0,
              remaining: booked.remaining,
              durationMs: now() - started,
            },
            "github request",
          );
          return { status, data: undefined as T, headers };
        }
        const limitWaitMs =
          status === undefined
            ? undefined
            : waitMsFromHeaders(status, headers, now());
        const transient =
          info.retry !== false &&
          status !== undefined &&
          (status >= 500 || status === 403 || status === 429);
        const waitMs =
          limitWaitMs !== undefined
            ? limitWaits < MAX_LIMIT_WAITS
              ? limitWaitMs
              : undefined
            : transient && retries < BACKOFF_MS.length
              ? BACKOFF_MS[retries]
              : undefined;
        logger.debug(
          {
            route,
            query: info.query,
            installationId,
            repo,
            status: status ?? 502,
            attempt,
            remaining: booked.remaining,
            durationMs: now() - started,
            retryInMs: waitMs,
          },
          "github request failed",
        );
        if (waitMs === undefined) {
          const message =
            (failure === undefined
              ? undefined
              : messageOf(
                  (failure.response as { data?: unknown } | undefined)?.data,
                )) ?? "request failed";
          throw new GithubError(status ?? 502, message);
        }
        if (limitWaitMs !== undefined) limitWaits++;
        else retries++;
        await sleep(waitMs);
      }
    }
  }

  async function callData<T>(
    route: string,
    send: () => Promise<Sent<T>>,
    info?: CallInfo,
  ): Promise<T> {
    return (await call(route, send, info)).data;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function oauth(
    app: GithubOAuthApp,
    grant: Record<string, string>,
  ): Promise<GithubOAuthTokens> {
    const route = "POST /login/oauth/access_token";
    const data = await callData(
      route,
      () =>
        octokit.request(route, {
          baseUrl: options.webUrl,
          headers: { accept: "application/json" },
          client_id: app.clientId,
          client_secret: app.clientSecret,
          ...grant,
        }),
      { retry: false },
    );
    // GitHub reports a rejected code or refresh token as 200 with an error body.
    const failure = oauthFailureSchema.safeParse(data);
    if (failure.success) {
      throw new GithubError(
        400,
        failure.data.error_description ?? failure.data.error,
        failure.data.error,
      );
    }
    const tokens = parse(oauthSuccessSchema, data, "OAuth token");
    return {
      accessToken: tokens.access_token,
      expiresInSeconds: tokens.expires_in,
      refreshToken: tokens.refresh_token,
      refreshTokenExpiresInSeconds: tokens.refresh_token_expires_in,
    };
  }

  return {
    budgets,

    async createInstallationToken(app, installationId) {
      const route = "POST /app/installations/{installation_id}/access_tokens";
      const created = parse(
        installationTokenSchema,
        await callData(route, () =>
          octokit.request(route, {
            installation_id: installationId,
            headers: bearer(signAppJwt(app)),
          }),
        ),
        "installation token",
      );
      const expiresAt = Date.parse(created.expires_at);
      if (Number.isNaN(expiresAt)) {
        throw new GithubError(502, "unexpected installation token response");
      }
      return { token: created.token, expiresAt };
    },

    async graphql(token, query, variables, meta) {
      assertReadOnlyDocument(query.document);
      const route = "POST /graphql";
      const response = parse(
        graphqlResponseSchema,
        await callData(
          route,
          () =>
            octokit.request(route, {
              headers: bearer(token),
              query: query.document,
              variables: variables ?? {},
            }),
          { ...meta, resource: "graphql", query: query.name },
        ),
        "GraphQL",
      );
      if (response.errors !== undefined && response.errors.length > 0) {
        const [first] = response.errors;
        throw new GithubError(
          502,
          first?.message ?? "GraphQL query failed",
          first?.type,
        );
      }
      return response.data;
    },

    async restGet(token, route, params, meta) {
      assertGetRoute(route, params);
      return callData(
        route,
        () => octokit.request(route, { ...params, headers: bearer(token) }),
        { ...meta, resource: "rest" },
      );
    },

    async restGetConditional(token, route, etag, params, meta) {
      assertGetRoute(route, params);
      const response = await call(
        route,
        () =>
          octokit.request(route, {
            ...params,
            headers: { ...bearer(token), "if-none-match": etag },
          }),
        { ...meta, resource: "rest", conditional: true },
      );
      if (response.status === 304) return { notModified: true };
      const newEtag = response.headers?.etag;
      return {
        notModified: false,
        data: response.data,
        etag: newEtag === undefined ? null : String(newEtag),
      };
    },

    async getUser(token) {
      const route = "GET /user";
      const user = parse(
        userSchema,
        await callData(route, () =>
          octokit.request(route, { headers: bearer(token) }),
        ),
        "user",
      );
      return {
        id: user.id,
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
      };
    },

    async listUserInstallations(token) {
      const route = "GET /user/installations";
      const pages = await callData(route, async () => ({
        status: 200,
        data: await octokit.paginate(
          octokit.request.endpoint.merge(route, {
            per_page: 100,
            headers: bearer(token),
          }),
        ),
      }));
      return pages.map((entry) => {
        const installation = parse(installationSchema, entry, "installation");
        return {
          id: installation.id,
          appId: installation.app_id,
          targetType: installation.target_type,
          account: installation.account ?? null,
          suspendedAt: installation.suspended_at ?? null,
          repositorySelection: installation.repository_selection,
        };
      });
    },

    async listInstallationRepositories(token, installationId) {
      const route = "GET /user/installations/{installation_id}/repositories";
      const pages = await callData(route, async () => ({
        status: 200,
        data: await octokit.paginate(
          octokit.request.endpoint.merge(route, {
            installation_id: installationId,
            per_page: 100,
            headers: bearer(token),
          }),
        ),
      }));
      return pages.map((entry) => {
        const repository = parse(repositorySchema, entry, "repository");
        return {
          id: repository.id,
          nodeId: repository.node_id,
          name: repository.name,
          fullName: repository.full_name,
          owner: repository.owner,
          private: repository.private,
          archived: repository.archived ?? false,
          hasIssues: repository.has_issues ?? true,
        };
      });
    },

    exchangeOAuthCode(app, code, redirectUri) {
      return oauth(app, {
        code,
        ...(redirectUri === undefined ? {} : { redirect_uri: redirectUri }),
      });
    },

    refreshOAuthToken(app, refreshToken) {
      return oauth(app, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    },

    async convertManifest(code) {
      const route = "POST /app-manifests/{code}/conversions";
      const app = parse(
        manifestSchema,
        await callData(route, () => octokit.request(route, { code }), {
          retry: false,
        }),
        "manifest conversion",
      );
      return {
        id: app.id,
        slug: app.slug,
        clientId: app.client_id,
        clientSecret: app.client_secret,
        webhookSecret: app.webhook_secret,
        pem: app.pem,
      };
    },
  };
}
