import type { GithubAppCredentials } from "../config/index.js";
import { GithubError } from "./errors.js";
import type {
  GithubClient,
  GithubConditionalResult,
  GithubGetRoute,
  GithubInstallationToken,
} from "./client.js";
import type { GithubBudgets } from "./rate-limit.js";
import { assertGetRoute, type GithubQuery } from "./query.js";

/** An installation token with less time left than this is renewed before use (SPEC §5.2). */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface InstallationClientOptions {
  github: Pick<
    GithubClient,
    | "budgets"
    | "createInstallationToken"
    | "graphql"
    | "restGet"
    | "restGetConditional"
  >;
  /** The App credentials in effect now, else null. */
  credentials: () => GithubAppCredentials | null;
  now?: () => number;
}

/** What a call is for, logged beside the installation (and booked against its budget). */
export interface RequestContext {
  /** `owner/name` of the repository the call concerns. */
  repo?: string;
}

/**
 * GitHub calls made as an installation (D-4). One method per kind; the token
 * is created, cached and renewed here and never leaves this module.
 */
export interface InstallationClient {
  /** What each installation has left; see {@link GithubBudgets}. */
  readonly budgets: GithubBudgets;
  /**
   * Runs a query as the installation, within the client's concurrency limits
   * and rate-limit handling (SPEC §6.1, §6.5).
   */
  graphql(
    installationId: number,
    query: GithubQuery,
    variables?: Record<string, unknown>,
    context?: RequestContext,
  ): Promise<unknown>;
  /** Runs a REST `GET` as the installation. */
  rest(
    installationId: number,
    route: GithubGetRoute,
    params?: Record<string, unknown>,
    context?: RequestContext,
  ): Promise<unknown>;
  /** Runs a REST `GET` as the installation with `If-None-Match: <etag>`. */
  restConditional(
    installationId: number,
    route: GithubGetRoute,
    etag: string,
    params?: Record<string, unknown>,
    context?: RequestContext,
  ): Promise<GithubConditionalResult>;
}

export function createInstallationClient({
  github,
  credentials,
  now = Date.now,
}: InstallationClientOptions): InstallationClient {
  const cache = new Map<string, GithubInstallationToken>();
  // Two concurrent callers for one installation share one token request.
  const creating = new Map<string, Promise<GithubInstallationToken>>();

  async function tokenFor(
    installationId: number,
  ): Promise<{ key: string; token: string }> {
    const app = credentials();
    if (app === null) {
      throw new Error("no GitHub App credentials to authenticate with");
    }
    const key = `${app.appId}:${String(installationId)}`;
    const cached = cache.get(key);
    if (
      cached !== undefined &&
      cached.expiresAt - now() > INSTALLATION_TOKEN_REFRESH_MARGIN_MS
    ) {
      return { key, token: cached.token };
    }
    let pending = creating.get(key);
    if (pending === undefined) {
      pending = github
        .createInstallationToken(app, installationId)
        .then((created) => {
          cache.set(key, created);
          return created;
        })
        .finally(() => creating.delete(key));
      creating.set(key, pending);
    }
    return { key, token: (await pending).token };
  }

  // A token GitHub rejects is dropped, so the next call asks for a new one.
  async function withToken<T>(
    installationId: number,
    send: (token: string) => Promise<T>,
  ): Promise<T> {
    const { key, token } = await tokenFor(installationId);
    try {
      return await send(token);
    } catch (error) {
      if (error instanceof GithubError && error.status === 401) {
        cache.delete(key);
      }
      throw error;
    }
  }

  return {
    budgets: github.budgets,

    async graphql(installationId, query, variables, context) {
      return withToken(installationId, (token) =>
        github.graphql(token, query, variables, {
          installationId,
          ...(context?.repo === undefined ? {} : { repo: context.repo }),
        }),
      );
    },

    async rest(installationId, route, params, context) {
      assertGetRoute(route, params);
      return withToken(installationId, (token) =>
        github.restGet(token, route, params, {
          installationId,
          ...(context?.repo === undefined ? {} : { repo: context.repo }),
        }),
      );
    },

    async restConditional(installationId, route, etag, params, context) {
      assertGetRoute(route, params);
      return withToken(installationId, (token) =>
        github.restGetConditional(token, route, etag, params, {
          installationId,
          ...(context?.repo === undefined ? {} : { repo: context.repo }),
        }),
      );
    },
  };
}
