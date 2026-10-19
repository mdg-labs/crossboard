import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { z, ZodError } from "zod";
import { activeInstallationIds } from "../access/index.js";
import type { Allowlist } from "../auth/sign-in/index.js";
import { schema, type Db } from "../db/index.js";
import { GithubError, type InstallationClient } from "../github/index.js";
import type { GithubQuery } from "../github/query.js";
import { queries } from "../github/queries/index.js";
import type { Jobs } from "../jobs/index.js";
import { repositoryStateSchema, skipReason } from "./discovery.js";
import {
  deleteIssues,
  deleteUnusedLabels,
  issueNodeSchema,
  storedIssueIds,
  toIssueData,
  writeIssues,
  type IssueData,
} from "./issue-data.js";

const { installations, repos } = schema;

export const SYNC_JOB = "sync.repo";

const pageSchema = z.object({
  repository: z
    .object({
      issues: z.object({
        totalCount: z.number(),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(issueNodeSchema.nullable()),
      }),
    })
    .nullable(),
});

const rateLimitSchema = z.object({
  rateLimit: z.object({ cost: z.number() }),
});

export interface SyncOptions {
  db: Db;
  installations: Pick<InstallationClient, "graphql">;
  /** Whether the installation is active now (SPEC FR-3). */
  isActive: (installationId: number) => boolean;
  logger: Logger;
  now?: () => number;
}

export type SyncOutcome = "synced" | "skipped" | "error";

export interface Sync {
  /**
   * Runs a repository's initial sync (SPEC §6.1): checks that it is neither
   * archived nor issues-disabled (marking it `skipped` when it is), pages its
   * open issues, and replaces the repo's issues, labels and assignees in one
   * transaction. The repo goes `syncing`, then `ready`; a failure that
   * outlasts the client's retries leaves it `error` with the message and
   * nothing replaced. Resolves to `skipped` for a repo that is gone, skipped,
   * already syncing here, or whose installation is unknown, suspended or no
   * longer active, which is checked again before every write.
   */
  syncRepo(repoId: string): Promise<SyncOutcome>;
}

const messageOf = (error: unknown): string =>
  error instanceof ZodError
    ? "unexpected response from GitHub"
    : error instanceof GithubError
      ? error.githubMessage
      : error instanceof Error
        ? error.message
        : "sync failed";

export function createSync({
  db,
  installations: github,
  isActive,
  logger,
  now = Date.now,
}: SyncOptions): Sync {
  const running = new Set<string>();

  const usable = (installationId: number): boolean => {
    const installation = db
      .select({ suspended: installations.suspended })
      .from(installations)
      .where(eq(installations.id, installationId))
      .get();
    return (
      installation !== undefined &&
      !installation.suspended &&
      isActive(installationId)
    );
  };

  /** Applies `fields` to the repo unless it is gone, skipped or its installation stopped being active. */
  function update(
    repoId: string,
    installationId: number,
    fields: Partial<typeof repos.$inferInsert>,
    from: readonly (typeof repos.$inferSelect)["syncState"][],
  ): boolean {
    return db.transaction((tx) => {
      if (!usable(installationId)) return false;
      return (
        tx
          .update(repos)
          .set({ ...fields, updatedAt: now() })
          .where(and(eq(repos.id, repoId), inArray(repos.syncState, [...from])))
          .run().changes > 0
      );
    });
  }

  /**
   * Returns a repo this run left `syncing` to `pending` when its write was
   * refused, so that discovery or the next start syncs it again.
   */
  function abandon(repoId: string): void {
    db.update(repos)
      .set({ syncState: "pending", updatedAt: now() })
      .where(and(eq(repos.id, repoId), eq(repos.syncState, "syncing")))
      .run();
  }

  async function run(repoId: string): Promise<SyncOutcome> {
    const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
    if (
      repo === undefined ||
      repo.syncState === "skipped" ||
      !usable(repo.installationId)
    ) {
      logger.info(
        { repoId },
        "repository sync skipped: the repository is gone or skipped, or its installation is not active",
      );
      return "skipped";
    }
    const installationId = repo.installationId;
    const fullName = `${repo.owner}/${repo.name}`;
    const startedAt = now();
    const live = ["pending", "syncing", "error", "ready"] as const;
    if (
      !update(
        repoId,
        installationId,
        { syncState: "syncing", syncDetail: null },
        live,
      )
    ) {
      logger.info(
        { installationId, repo: fullName },
        "repository sync skipped: the repository or its installation changed",
      );
      return "skipped";
    }

    let pages = 0;
    let cost = 0;
    const send = async (
      query: GithubQuery,
      variables: Record<string, unknown>,
    ): Promise<unknown> => {
      const data = await github.graphql(installationId, query, variables, {
        repo: fullName,
      });
      const limit = rateLimitSchema.safeParse(data);
      if (limit.success) cost += limit.data.rateLimit.cost;
      return data;
    };

    let fetched: IssueData[];
    try {
      const states = z
        .object({ nodes: z.array(z.unknown()) })
        .parse(await send(queries.repositoryStates, { ids: [repoId] }));
      const state = repositoryStateSchema.safeParse(states.nodes[0]);
      if (!state.success) throw new Error("the repository is not readable");
      const reason = skipReason(state.data);
      if (reason !== undefined) {
        if (
          !update(
            repoId,
            installationId,
            { syncState: "skipped", syncDetail: reason, openIssueCount: 0 },
            ["syncing"],
          )
        ) {
          abandon(repoId);
        }
        logger.info(
          { installationId, repo: fullName, reason },
          "repository sync skipped: the repository fails the check",
        );
        return "skipped";
      }

      fetched = [];
      let after: string | null = null;
      for (;;) {
        const page = pageSchema.parse(
          await send(queries.openIssuesPage, {
            owner: repo.owner,
            name: repo.name,
            after,
          }),
        );
        if (page.repository === null) {
          throw new Error("the repository is not readable");
        }
        pages++;
        const { nodes, pageInfo } = page.repository.issues;
        for (const node of nodes) {
          if (node !== null) fetched.push(toIssueData(node));
        }
        if (!pageInfo.hasNextPage) break;
        if (pageInfo.endCursor === null) {
          throw new Error("GitHub returned no cursor for the next page");
        }
        after = pageInfo.endCursor;
      }
    } catch (error) {
      logger.error(
        { err: error, installationId, repo: fullName },
        "repository sync failed",
      );
      if (
        !update(
          repoId,
          installationId,
          { syncState: "error", syncDetail: messageOf(error) },
          ["syncing"],
        )
      ) {
        abandon(repoId);
      }
      return "error";
    }

    const at = now();
    const written = db.transaction((tx) => {
      const current = tx
        .select({ syncState: repos.syncState })
        .from(repos)
        .where(eq(repos.id, repoId))
        .get();
      if (
        current === undefined ||
        current.syncState !== "syncing" ||
        !usable(installationId)
      ) {
        return false;
      }
      writeIssues(tx, repoId, fetched, at);
      const returned = new Set(fetched.map((issue) => issue.id));
      deleteIssues(
        tx,
        storedIssueIds(tx, repoId).filter((id) => !returned.has(id)),
      );
      deleteUnusedLabels(tx, repoId);
      tx.update(repos)
        .set({
          syncState: "ready",
          syncDetail: null,
          openIssueCount: fetched.length,
          lastFullSyncAt: at,
          reconcileSince: new Date(startedAt).toISOString(),
          updatedAt: at,
        })
        .where(eq(repos.id, repoId))
        .run();
      return true;
    });
    if (!written) {
      abandon(repoId);
      logger.info(
        { installationId, repo: fullName },
        "repository sync discarded: the repository or its installation changed",
      );
      return "skipped";
    }
    logger.info(
      { installationId, repo: fullName, issues: fetched.length, pages, cost },
      "repository synced",
    );
    return "synced";
  }

  return {
    async syncRepo(repoId) {
      if (running.has(repoId)) return "skipped";
      running.add(repoId);
      try {
        return await run(repoId);
      } finally {
        running.delete(repoId);
      }
    },
  };
}

/** Enqueues a repository's sync; one pending job per repository. */
export function enqueueSync(
  jobs: Jobs,
  repo: { id: string; installationId: number },
): boolean {
  return jobs.enqueue(
    SYNC_JOB,
    { repoId: repo.id },
    { key: repo.id, installationId: repo.installationId },
  );
}

/** Registers the job that runs {@link Sync.syncRepo} for one repository. */
export function registerSyncJob(jobs: Jobs, sync: Sync): void {
  jobs.register<{ repoId: string }>(SYNC_JOB, async ({ repoId }) => {
    await sync.syncRepo(repoId);
  });
}

/**
 * Queues the sync of every repo of an active installation that is `pending`
 * or `syncing`, which a restart interrupted (SPEC §7.3).
 */
export function enqueueSyncAtStart(
  jobs: Jobs,
  db: Pick<Db, "select">,
  allowlist: Allowlist,
): void {
  const active = activeInstallationIds(db, allowlist);
  for (const repo of db
    .select({ id: repos.id, installationId: repos.installationId })
    .from(repos)
    .where(inArray(repos.syncState, ["pending", "syncing"]))
    .all()) {
    if (active.has(repo.installationId)) enqueueSync(jobs, repo);
  }
}
