import type { Logger } from "pino";
import { z } from "zod";
import type { GithubAppCredentials } from "../config/index.js";
import { GithubError } from "./errors.js";
import type {
  GithubClient,
  GithubGetRoute,
  GithubInstallationToken,
} from "./client.js";
import { assertGetRoute, type GithubQuery } from "./query.js";

/** An installation token with less time left than this is renewed before use (SPEC §5.2). */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface InstallationClientOptions {
  github: Pick<GithubClient, "createInstallationToken" | "graphql" | "restGet">;
  /** The App credentials in effect now, else null. */
  credentials: () => GithubAppCredentials | null;
  logger: Logger;
  now?: () => number;
}

/** What a call is for, logged beside the installation. */
export interface RequestContext {
  /** `owner/name` of the repository the call concerns. */
  repo?: string;
}

/**
 * GitHub calls made as an installation (D-4). One method per kind; the token
 * is created, cached and renewed here and never leaves this module.
 */
export interface InstallationClient {
  /** Runs a query as the installation. Logs its `rateLimit { cost }` at `debug`. */
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
}

const costSchema = z.object({ rateLimit: z.object({ cost: z.number() }) });

export function createInstallationClient({
  github,
  credentials,
  logger,
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
    async graphql(installationId, query, variables, context) {
      const data = await withToken(installationId, (token) =>
        github.graphql(token, query, variables),
      );
      const cost = costSchema.safeParse(data);
      logger.debug(
        {
          installationId,
          repo: context?.repo,
          query: query.name,
          cost: cost.success ? cost.data.rateLimit.cost : undefined,
        },
        "github graphql",
      );
      return data;
    },

    async rest(installationId, route, params, context) {
      assertGetRoute(route, params);
      const data = await withToken(installationId, (token) =>
        github.restGet(token, route, params),
      );
      logger.debug(
        { installationId, repo: context?.repo, route },
        "github rest",
      );
      return data;
    },
  };
}
