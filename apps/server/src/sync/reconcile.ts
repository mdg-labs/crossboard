import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { GithubError, type InstallationClient } from "../github/index.js";
import type { Jobs } from "../jobs/index.js";
import { NO_ETAG } from "./discovery.js";
import type { Refetch } from "./refetch.js";

const { installations, repos } = schema;

export const RECONCILE_JOB = "sync.reconcile";
export const RECONCILE_REPO_JOB = "sync.reconcile-repo";

const ROUTE = "GET /repos/{owner}/{repo}/issues";
const PAGE_SIZE = 100;
/** Requests one round may make; a repo that keeps filling pages ends it as an error. */
const MAX_PAGES = 100;

const pageSchema = z.array(
  z.object({
    node_id: z.string(),
    state: z.enum(["open", "closed"]),
    updated_at: z.string(),
    pull_request: z.unknown().optional(),
  }),
);

export type ReconcileOutcome = "reconciled" | "unchanged" | "skipped" | "error";

export interface ReconcileOptions {
  db: Db;
  installations: Pick<InstallationClient, "rest" | "restConditional">;
  /** Whether the installation is active now (SPEC FR-3). */
  isActive: (installationId: number) => boolean;
  /** Refetches open issues and removes closed ones (SPEC §6.2, §8.2). */
  issues: Pick<Refetch, "refetch" | "remove">;
  logger: Logger;
  now?: () => number;
}

export interface Reconcile {
  /**
   * Runs one reconciliation round for a `ready` repo (SPEC §6.3): lists the
   * issues updated since its `reconcile_since`, oldest first, following the
   * pages. The first page is sent with the stored ETag, and a `304` ends the
   * round. Each following page restarts the listing with `since` set to the
   * last `updated_at` of the page before (offset paging would skip an issue
   * when one already read is updated meanwhile), so issues are listed more
   * than once and are de-duplicated by node id. Only when a full page ends on
   * the `since` it was asked with does the listing page by offset within that
   * `since`, and an issue it then lists twice fails the round. Pull requests are ignored, closed issues are removed as closed and
   * open ones are refetched by node id with the repo's installation, which also
   * stores an issue opened since the last round.
   *
   * Everything is fetched before anything is applied, and the repo's
   * `reconcile_since`, `rest_etag` and `last_reconciled_at` are written only
   * after every issue has been applied, so a failed round is repeated whole.
   * `reconcile_since` advances to the newest `updated_at` listed and drops the
   * ETag, which belonged to the old `since`; while it does not move, the first
   * page's ETag is kept when the round was a single page. The write is
   * refused when the repo stopped being `ready`, its `reconcile_since` changed
   * (a sync ran meanwhile) or its installation stopped being active.
   * Resolves to `skipped` for a repo that is not ready or whose installation
   * is unknown, suspended or inactive, and to `error` for a failed round.
   */
  reconcileRepo(repoId: string): Promise<ReconcileOutcome>;
}

const messageOf = (error: unknown): string =>
  error instanceof GithubError
    ? error.githubMessage
    : error instanceof Error
      ? error.message
      : "reconciliation failed";

export function createReconcile({
  db,
  installations: github,
  isActive,
  issues,
  logger,
  now = Date.now,
}: ReconcileOptions): Reconcile {
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

  async function run(repoId: string): Promise<ReconcileOutcome> {
    const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
    if (
      repo === undefined ||
      repo.syncState !== "ready" ||
      repo.reconcileSince === null ||
      !usable(repo.installationId)
    ) {
      logger.debug(
        { repoId },
        "repository reconciliation skipped: the repository is not ready, or its installation is not active",
      );
      return "skipped";
    }
    const { installationId, reconcileSince: since } = repo;
    const fullName = `${repo.owner}/${repo.name}`;
    const context = { repo: fullName };
    const query = {
      owner: repo.owner,
      repo: repo.name,
      state: "all",
      since,
      sort: "updated",
      direction: "asc",
      per_page: PAGE_SIZE,
    };

    /** Writes the round's result unless the repo changed under it. */
    const store = (fields: Partial<typeof repos.$inferInsert>): boolean =>
      db.transaction((tx) => {
        if (!usable(installationId)) return false;
        return (
          tx
            .update(repos)
            .set({ ...fields, lastReconciledAt: now() })
            .where(
              and(
                eq(repos.id, repoId),
                eq(repos.syncState, "ready"),
                eq(repos.reconcileSince, since),
              ),
            )
            .run().changes > 0
        );
      });

    try {
      const first = await github.restConditional(
        installationId,
        ROUTE,
        repo.restEtag ?? NO_ETAG,
        query,
        context,
      );
      if (first.notModified) {
        if (repo.restEtag === null) {
          throw new Error("GitHub answered 304 to a request without an ETag");
        }
        if (!store({})) return discarded(fullName, installationId);
        logger.debug(
          { installationId, repo: fullName },
          "repository reconciled: nothing changed",
        );
        return "unchanged";
      }

      // An issue updated while the pages are read is listed twice; its last
      // state wins.
      const listed = new Map<string, z.infer<typeof pageSchema>[number]>();
      let page = pageSchema.parse(first.data);
      let pages = 1;
      let base = since;
      let offset = 1;
      for (;;) {
        for (const item of page) {
          if (offset > 1 && listed.has(item.node_id)) {
            throw new Error(
              "the issue list changed while it was read, so the round is repeated",
            );
          }
          listed.set(item.node_id, item);
        }
        if (page.length < PAGE_SIZE) break;
        if (pages >= MAX_PAGES) {
          throw new Error(
            `more than ${String(MAX_PAGES * PAGE_SIZE)} issues changed since the last round`,
          );
        }
        const last = page[page.length - 1]?.updated_at ?? base;
        if (Date.parse(last) > Date.parse(base)) {
          base = last;
          offset = 1;
        } else {
          offset++;
        }
        page = pageSchema.parse(
          await github.rest(
            installationId,
            ROUTE,
            offset > 1
              ? { ...query, since: base, page: offset }
              : { ...query, since: base },
            context,
          ),
        );
        pages++;
      }

      let newest = since;
      let pulls = 0;
      const states = new Map<string, "open" | "closed">();
      for (const item of listed.values()) {
        if (Date.parse(item.updated_at) > Date.parse(newest)) {
          newest = item.updated_at;
        }
        if (item.pull_request !== undefined) pulls++;
        else states.set(item.node_id, item.state);
      }
      const open = [...states].filter(([, state]) => state === "open");
      const closed = [...states].filter(([, state]) => state === "closed");

      let cost = await issues.remove(
        closed.map(([id]) => id),
        "closed",
      );
      cost += await issues.refetch(
        open.map(([id]) => id),
        installationId,
      );

      const advanced = newest !== since;
      const stored = store(
        advanced
          ? { reconcileSince: newest, restEtag: null }
          : { restEtag: pages === 1 ? first.etag : null },
      );
      if (!stored) return discarded(fullName, installationId);
      logger.info(
        {
          installationId,
          repo: fullName,
          pages,
          open: open.length,
          closed: closed.length,
          pulls,
          cost,
        },
        "repository reconciled",
      );
      return "reconciled";
    } catch (error) {
      logger.error(
        { err: error, installationId, repo: fullName },
        `repository reconciliation failed: ${messageOf(error)}`,
      );
      return "error";
    }
  }

  function discarded(
    fullName: string,
    installationId: number,
  ): ReconcileOutcome {
    logger.info(
      { installationId, repo: fullName },
      "repository reconciliation discarded: the repository or its installation changed",
    );
    return "skipped";
  }

  return {
    async reconcileRepo(repoId) {
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

/** Enqueues a repository's reconciliation; one pending job per repository. */
export function enqueueReconcile(
  jobs: Jobs,
  repo: { id: string; installationId: number },
): boolean {
  return jobs.enqueue(
    RECONCILE_REPO_JOB,
    { repoId: repo.id },
    { key: repo.id, installationId: repo.installationId },
  );
}

/**
 * Registers the job that reconciles one repository, and the job that queues
 * it for every `ready` repo of an active, non-suspended installation, which is
 * scheduled every `intervalMs` (SPEC §6.3).
 */
export function registerReconcileJobs(
  jobs: Jobs,
  reconcile: Reconcile,
  db: Pick<Db, "select">,
  isActive: (installationId: number) => boolean,
  intervalMs: number,
): void {
  jobs.register<{ repoId: string }>(RECONCILE_REPO_JOB, async ({ repoId }) => {
    await reconcile.reconcileRepo(repoId);
  });
  jobs.register(RECONCILE_JOB, () => {
    const candidates = db
      .select({ id: repos.id, installationId: repos.installationId })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(
        and(eq(repos.syncState, "ready"), eq(installations.suspended, false)),
      )
      .all();
    for (const repo of candidates) {
      if (isActive(repo.installationId)) enqueueReconcile(jobs, repo);
    }
  });
  jobs.schedule(RECONCILE_JOB, intervalMs);
}
