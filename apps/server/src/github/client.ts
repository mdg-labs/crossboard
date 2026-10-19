import { Octokit, RequestError } from "octokit";
import type { Logger } from "pino";
import { z } from "zod";
import { GithubError } from "./errors.js";

export interface GithubClientOptions {
  /** `config.githubApiUrl` */
  apiUrl: string;
  /** `config.githubWebUrl` */
  webUrl: string;
  logger: Logger;
}

/** The App's OAuth credentials; the caller owns them, the client never reads config. */
export interface GithubOAuthApp {
  clientId: string;
  clientSecret: string;
}

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
 * credential exchanges D-18 allows: the OAuth code exchange and refresh, and
 * the manifest conversion.
 */
export interface GithubClient {
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

  /**
   * Every request goes through here: it logs the route template and the
   * outcome at `debug` (never a token, URL parameter or body) and turns a
   * failure into a GithubError that carries status and GitHub's message only.
   */
  async function call<T>(
    route: string,
    send: () => Promise<{ status: number; data: T }>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const response = await send();
      logger.debug(
        { route, status: response.status, durationMs: Date.now() - started },
        "github request",
      );
      return response.data;
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 502;
      const message =
        (error instanceof RequestError
          ? messageOf((error.response as { data?: unknown } | undefined)?.data)
          : undefined) ?? "request failed";
      logger.debug(
        { route, status, durationMs: Date.now() - started },
        "github request failed",
      );
      throw new GithubError(status, message);
    }
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function oauth(
    app: GithubOAuthApp,
    grant: Record<string, string>,
  ): Promise<GithubOAuthTokens> {
    const route = "POST /login/oauth/access_token";
    const data = await call(route, () =>
      octokit.request(route, {
        baseUrl: options.webUrl,
        headers: { accept: "application/json" },
        client_id: app.clientId,
        client_secret: app.clientSecret,
        ...grant,
      }),
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
    async getUser(token) {
      const route = "GET /user";
      const user = parse(
        userSchema,
        await call(route, () =>
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
      const pages = await call(route, async () => ({
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
      const pages = await call(route, async () => ({
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
        await call(route, () => octokit.request(route, { code })),
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
