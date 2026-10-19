import { eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { UserTokens } from "../auth/tokens.js";
import { schema, type Db } from "../db/index.js";
import type {
  GithubClient,
  GithubInstallation,
  GithubRepository,
} from "../github/index.js";
import type { Allowlist } from "../auth/sign-in/index.js";
import { GithubError } from "../github/index.js";
import { activeInstallationIds } from "./active.js";
import { purgeInstallations } from "./purge.js";

const { installations, repos, userInstallations, userRepoAccess } = schema;

// Keeps one statement under SQLite's bound-parameter limit.
const CHUNK = 200;

export interface AccessOptions {
  db: Db;
  github: Pick<
    GithubClient,
    "listUserInstallations" | "listInstallationRepositories"
  >;
  tokens: Pick<UserTokens, "accessToken" | "rejected">;
  allowlist: Allowlist;
  logger: Logger;
  /**
   * Called, after the computation is stored, with the installations that
   * became active through it (SPEC FR-3). Repository discovery hangs off it.
   * A throw is logged and does not change the computation's result.
   */
  onActivated?: (installationIds: number[]) => void;
  /**
   * Called, after the computation is stored, with the active, non-suspended
   * installations that the computation recorded a repo for that was not
   * stored before, so the repo is discovered and synced without waiting for
   * the scheduled discovery (SPEC §6.1).
   */
  onReposAdded?: (installationIds: number[]) => void;
  now?: () => number;
}

export interface ComputeOptions {
  /**
   * Treat a 401 from GitHub as the user having revoked the authorization
   * (SPEC FR-7): their tokens and sessions are deleted and the result is
   * `revoked`. Only for a stored token; a token GitHub has just issued that
   * it rejects is no revocation.
   */
  revokeRejected?: boolean;
}

export interface Access {
  /**
   * Recomputes the user's access (SPEC FR-8) with their token and replaces
   * their `user_installations` and `user_repo_access` rows. Resolves to
   * `skipped` when the user has no usable token, or when a rejected token had
   * been replaced in the meantime. A GitHub failure throws and leaves the
   * stored access as it was. The active set (SPEC FR-3) is derived again in
   * the same transaction: the installations it lost are purged (SPEC §8.2),
   * the ones it gained are logged and passed to `onActivated`, and the active
   * ones it recorded new repos for are passed to `onReposAdded`.
   */
  compute(
    userId: number,
    options?: ComputeOptions,
  ): Promise<"computed" | "skipped" | "revoked">;
}

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += CHUNK) {
    out.push(items.slice(index, index + CHUNK));
  }
  return out;
};

interface Reached {
  installation: GithubInstallation & {
    account: NonNullable<GithubInstallation["account"]>;
  };
  repositories: GithubRepository[];
}

export function createAccess({
  db,
  github,
  tokens,
  allowlist,
  logger,
  onActivated,
  onReposAdded,
  now = Date.now,
}: AccessOptions): Access {
  async function fetchReached(token: string): Promise<Reached[]> {
    const reached: Reached[] = [];
    for (const installation of await github.listUserInstallations(token)) {
      const { account } = installation;
      if (account === null) {
        logger.warn(
          { installationId: installation.id },
          "an installation without an account was ignored",
        );
        continue;
      }
      reached.push({
        installation: { ...installation, account },
        // A suspended installation grants no repository access.
        repositories:
          installation.suspendedAt === null
            ? await github.listInstallationRepositories(token, installation.id)
            : [],
      });
    }
    return reached;
  }

  function store(userId: number, reached: Reached[], at: number) {
    return db.transaction((tx) => {
      const before = activeInstallationIds(tx, allowlist);
      for (const { installation } of reached) {
        const fields = {
          accountLogin: installation.account.login,
          accountId: installation.account.id,
          accountType:
            installation.targetType === "Organization"
              ? ("Organization" as const)
              : ("User" as const),
          suspended: installation.suspendedAt !== null,
          updatedAt: at,
        };
        tx.insert(installations)
          .values({ id: installation.id, createdAt: at, ...fields })
          .onConflictDoUpdate({ target: installations.id, set: fields })
          .run();
      }

      tx.delete(userInstallations)
        .where(eq(userInstallations.userId, userId))
        .run();
      tx.delete(userRepoAccess).where(eq(userRepoAccess.userId, userId)).run();

      for (const batch of chunks(reached)) {
        tx.insert(userInstallations)
          .values(
            batch.map(({ installation }) => ({
              userId,
              installationId: installation.id,
              computedAt: at,
            })),
          )
          .run();
      }

      const found = new Map<string, { repo: GithubRepository; by: number }>();
      for (const { installation, repositories } of reached) {
        for (const repo of repositories) {
          found.set(repo.nodeId, { repo, by: installation.id });
        }
      }
      let granted = 0;
      const addedBy = new Set<number>();
      for (const batch of chunks([...found.values()])) {
        const known = new Set(
          tx
            .select({ id: repos.id })
            .from(repos)
            .where(
              inArray(
                repos.id,
                batch.map(({ repo }) => repo.nodeId),
              ),
            )
            .all()
            .map(({ id }) => id),
        );
        // Identity fields only: sync state belongs to repository discovery.
        // A row that clashes on its unique keys is left alone, and the repo
        // then grants no access.
        tx.insert(repos)
          .values(
            batch.map(({ repo, by }) => ({
              id: repo.nodeId,
              databaseId: repo.id,
              installationId: by,
              owner: repo.owner.login,
              name: repo.name,
              private: repo.private,
              syncState: "pending" as const,
              openIssueCount: 0,
              createdAt: at,
              updatedAt: at,
            })),
          )
          .onConflictDoNothing()
          .run();
        const present = tx
          .select({ id: repos.id })
          .from(repos)
          .where(
            inArray(
              repos.id,
              batch.map(({ repo }) => repo.nodeId),
            ),
          )
          .all();
        if (present.length < batch.length) {
          logger.warn(
            { userId, skipped: batch.length - present.length },
            "repositories that clash with a stored repository were left out of the user's access",
          );
        }
        for (const { id } of present) {
          const entry = found.get(id);
          if (entry !== undefined && !known.has(id)) addedBy.add(entry.by);
        }
        for (const part of chunks(present)) {
          tx.insert(userRepoAccess)
            .values(
              part.map(({ id }) => ({ userId, repoId: id, computedAt: at })),
            )
            .run();
        }
        granted += present.length;
      }
      const after = activeInstallationIds(tx, allowlist);
      const deactivated = [...before].filter((id) => !after.has(id));
      const purged = purgeInstallations(tx, deactivated);
      const suspended = new Set(
        reached
          .filter(({ installation }) => installation.suspendedAt !== null)
          .map(({ installation }) => installation.id),
      );
      return {
        granted,
        purged,
        activated: [...after].filter((id) => !before.has(id)),
        deactivated,
        added: [...addedBy].filter((id) => after.has(id) && !suspended.has(id)),
      };
    });
  }

  return {
    async compute(userId, { revokeRejected = false } = {}) {
      const token = await tokens.accessToken(userId);
      if (token === null) {
        logger.info({ userId }, "access not computed: the user has no token");
        return "skipped";
      }
      let reached;
      try {
        reached = await fetchReached(token);
      } catch (error) {
        if (
          revokeRejected &&
          error instanceof GithubError &&
          error.status === 401
        ) {
          return tokens.rejected(userId, token) ? "revoked" : "skipped";
        }
        throw error;
      }
      const { granted, purged, activated, deactivated, added } = store(
        userId,
        reached,
        now(),
      );
      logger.info(
        {
          userId,
          installations: reached.length,
          repos: granted,
          activated,
          deactivated,
          purged,
          added,
        },
        "user access computed",
      );
      // The access is stored and reported whatever the queueing does.
      for (const [installationIds, notify] of [
        [activated, onActivated],
        [added, onReposAdded],
      ] as const) {
        if (installationIds.length === 0) continue;
        try {
          notify?.(installationIds);
        } catch (error) {
          logger.error(
            { err: error, userId, installations: installationIds },
            "queueing discovery after an access computation failed; the scheduled discovery picks it up",
          );
        }
      }
      return "computed";
    },
  };
}
