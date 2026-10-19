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
   * stored access as it was. The active set (SPEC FR-3) is derived again
   * afterwards, and the installations it gained or lost are logged.
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

  function store(userId: number, reached: Reached[], at: number): number {
    return db.transaction((tx) => {
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
      for (const batch of chunks([...found.values()])) {
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
        for (const part of chunks(present)) {
          tx.insert(userRepoAccess)
            .values(
              part.map(({ id }) => ({ userId, repoId: id, computedAt: at })),
            )
            .run();
        }
        granted += present.length;
      }
      return granted;
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
      const before = activeInstallationIds(db, allowlist);
      const granted = store(userId, reached, now());
      const after = activeInstallationIds(db, allowlist);
      const activated = [...after].filter((id) => !before.has(id));
      const deactivated = [...before].filter((id) => !after.has(id));
      logger.info(
        {
          userId,
          installations: reached.length,
          repos: granted,
          activated,
          deactivated,
        },
        "user access computed",
      );
      return "computed";
    },
  };
}
