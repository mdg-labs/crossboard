import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import { purgeRepos } from "../access/purge.js";
import { schema, type Db } from "../db/index.js";
import type { InstallationClient } from "../github/index.js";
import { queries } from "../github/queries/index.js";
import type { Jobs } from "../jobs/index.js";

const { installations, repos } = schema;

export const DISCOVERY_JOB = "sync.discover";
export const DISCOVERY_SCHEDULE_JOB = "sync.discover-all";
export const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

const PAGE_SIZE = 100;
/** How many repositories one state query covers (SPEC §5.3). */
export const REPOSITORY_STATES_BATCH = 25;
const ROUTE = "GET /installation/repositories";
// An ETag no response carries, so a page that has no stored ETag is fetched
// through the conditional route and yields the ETag to keep.
export const NO_ETAG = '"crossboard-no-etag"';
// Keeps one statement under SQLite's bound-parameter limit.
const CHUNK = 200;

const pageSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number(),
      node_id: z.string(),
      name: z.string(),
      owner: z.object({ login: z.string() }),
      private: z.boolean(),
    }),
  ),
});

const verifiedPageSchema = z.object({
  total_count: z.number(),
  repositories: z.array(z.object({ node_id: z.string() })),
});

export const repositoryStateSchema = z.object({
  id: z.string(),
  isArchived: z.boolean(),
  hasIssuesEnabled: z.boolean(),
  issues: z.object({ totalCount: z.number() }),
});

/** Why a repository is never synced (SPEC §5.3), or undefined when it is. */
export function skipReason(
  state: z.infer<typeof repositoryStateSchema>,
): string | undefined {
  return state.isArchived
    ? "archived"
    : !state.hasIssuesEnabled
      ? "issues disabled"
      : undefined;
}

interface Listed {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  private: boolean;
}

export interface DiscoveryOptions {
  db: Db;
  installations: Pick<InstallationClient, "graphql" | "restConditional">;
  /** Whether the installation is active now (SPEC FR-3). */
  isActive: (installationId: number) => boolean;
  logger: Logger;
  /**
   * Called after each discovery with the installation's repos that are
   * `pending`, so their initial sync (SPEC §6.1) can be queued.
   */
  onPending: (repos: { id: string; installationId: number }[]) => void;
  now?: () => number;
}

export interface Discovery {
  /**
   * Lists the installation's repositories (SPEC §5.3), records them, and
   * decides each new or skipped one's sync state from one batched query per
   * 25 repos: archived and issues-disabled repos are `skipped` with the
   * reason, repos without open issues are `ready`, the rest stay `pending`
   * with their open-issue count. Repos already past `pending` keep their
   * state; one the response carries no state for is recorded `pending` and
   * left as it is. A repo that a sync or a webhook moved on while the GitHub
   * calls ran keeps its state. A stored repo of the installation that the
   * listing does not contain is purged (SPEC §8.2) only when a second listing
   * of the installation's repositories, read after the first, is verified
   * complete (every page reports the same `total_count` and the distinct ids
   * equal it) and also lacks it, since a listing read page by page can skip a
   * repo that is still installed; an error or an incomplete second listing
   * keeps every such repo. Readability by the installation token is not
   * evidence: it reads any public repository. A repo stored after the first
   * listing began is never purged, since a computation may record a repo the
   * listing predates. This removes a repo that an access computation
   * re-created after a purge.
   * Resolves to `skipped` for an installation that is unknown,
   * suspended or no longer active, checked again before anything is written,
   * since the GitHub calls can outlast a purge. A GitHub failure, including a
   * GraphQL error such as `NOT_FOUND` for a repo deleted since the listing,
   * throws before anything is written.
   */
  discover(installationId: number): Promise<"discovered" | "skipped">;
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";

type Outcome =
  | { state: "skipped"; detail: string }
  | { state: "ready" }
  | { state: "pending"; openIssues: number };

export function createDiscovery({
  db,
  installations: github,
  isActive,
  logger,
  onPending,
  now = Date.now,
}: DiscoveryOptions): Discovery {
  // The last answer for each page of each installation's list.
  const pagesSeen = new Map<string, { etag: string; repositories: Listed[] }>();

  async function list(installationId: number): Promise<Listed[]> {
    const listed: Listed[] = [];
    for (let page = 1; ; page++) {
      const key = `${String(installationId)}:${String(page)}`;
      const seen = pagesSeen.get(key);
      const answer = await github.restConditional(
        installationId,
        ROUTE,
        seen?.etag ?? NO_ETAG,
        { per_page: PAGE_SIZE, page },
      );
      let repositories: Listed[];
      if (answer.notModified) {
        if (seen === undefined) {
          throw new Error("GitHub answered 304 to a request without an ETag");
        }
        repositories = seen.repositories;
      } else {
        repositories = pageSchema
          .parse(answer.data)
          .repositories.map((entry) => ({
            id: entry.id,
            nodeId: entry.node_id,
            owner: entry.owner.login,
            name: entry.name,
            private: entry.private,
          }));
        if (answer.etag === null) pagesSeen.delete(key);
        else pagesSeen.set(key, { etag: answer.etag, repositories });
      }
      listed.push(...repositories);
      if (repositories.length < PAGE_SIZE) return listed;
    }
  }

  async function check(
    installationId: number,
    candidates: Listed[],
  ): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    for (const batch of chunks(candidates, REPOSITORY_STATES_BATCH)) {
      const data = z.object({ nodes: z.array(z.unknown()) }).parse(
        await github.graphql(installationId, queries.repositoryStates, {
          ids: batch.map((repo) => repo.nodeId),
        }),
      );
      const states = new Map<string, z.infer<typeof repositoryStateSchema>>();
      for (const node of data.nodes) {
        const parsed = repositoryStateSchema.safeParse(node);
        if (parsed.success) states.set(parsed.data.id, parsed.data);
      }
      for (const repo of batch) {
        const state = states.get(repo.nodeId);
        if (state === undefined) {
          logger.warn(
            { installationId, repo: `${repo.owner}/${repo.name}` },
            "a repository could not be checked and was not changed",
          );
          continue;
        }
        const reason = skipReason(state);
        outcomes.set(
          repo.nodeId,
          reason !== undefined
            ? { state: "skipped", detail: reason }
            : state.issues.totalCount === 0
              ? { state: "ready" }
              : { state: "pending", openIssues: state.issues.totalCount },
        );
      }
    }
    return outcomes;
  }

  /**
   * Lists the installation's repositories again, without ETags, and returns
   * their node ids only when the listing is complete: every page reports the
   * same `total_count` and the distinct ids seen equal it. Anything else
   * throws.
   */
  async function listVerified(installationId: number): Promise<Set<string>> {
    const ids = new Set<string>();
    let total: number | undefined;
    for (let page = 1; ; page++) {
      if (total !== undefined && page > Math.ceil(total / PAGE_SIZE) + 1) {
        throw new Error("the repository listing does not end");
      }
      const answer = await github.restConditional(
        installationId,
        ROUTE,
        NO_ETAG,
        { per_page: PAGE_SIZE, page },
      );
      if (answer.notModified) {
        throw new Error("GitHub answered 304 to a request without an ETag");
      }
      const parsed = verifiedPageSchema.parse(answer.data);
      if (total !== undefined && parsed.total_count !== total) {
        throw new Error("the repository count changed while listing");
      }
      total = parsed.total_count;
      for (const entry of parsed.repositories) ids.add(entry.node_id);
      if (parsed.repositories.length < PAGE_SIZE || ids.size >= total) break;
    }
    if (ids.size !== total) {
      throw new Error("the repository listing is incomplete");
    }
    return ids;
  }

  return {
    async discover(installationId) {
      const installation = db
        .select()
        .from(installations)
        .where(eq(installations.id, installationId))
        .get();
      if (
        installation === undefined ||
        installation.suspended ||
        !isActive(installationId)
      ) {
        logger.info(
          { installationId },
          "repository discovery skipped: the installation is unknown, suspended or not active",
        );
        return "skipped";
      }

      const startedAt = now();
      const listed = await list(installationId);
      const stored = new Map(
        chunks(listed, CHUNK).flatMap((part) =>
          db
            .select({ id: repos.id, syncState: repos.syncState })
            .from(repos)
            .where(
              inArray(
                repos.id,
                part.map((repo) => repo.nodeId),
              ),
            )
            .all()
            .map((row) => [row.id, row.syncState] as const),
        ),
      );
      const outcomes = await check(
        installationId,
        listed.filter((repo) => {
          const state = stored.get(repo.nodeId);
          return (
            state === undefined || state === "pending" || state === "skipped"
          );
        }),
      );

      const listedIds = new Set(listed.map((repo) => repo.nodeId));
      const candidates = db
        .select({ id: repos.id, createdAt: repos.createdAt })
        .from(repos)
        .where(eq(repos.installationId, installationId))
        .all()
        .filter((row) => !listedIds.has(row.id) && row.createdAt <= startedAt)
        .map((row) => row.id);
      const gone = new Set<string>();
      if (candidates.length > 0) {
        try {
          const again = await listVerified(installationId);
          for (const id of candidates) if (!again.has(id)) gone.add(id);
        } catch (error) {
          logger.warn(
            { err: error, installationId },
            "repositories missing from the listing could not be confirmed removed and were kept",
          );
        }
      }

      const at = now();
      const counts = {
        created: 0,
        skipped: 0,
        ready: 0,
        pending: 0,
        purged: 0,
      };
      const written = db.transaction((tx) => {
        const current = tx
          .select({ suspended: installations.suspended })
          .from(installations)
          .where(eq(installations.id, installationId))
          .get();
        if (
          current === undefined ||
          current.suspended ||
          !isActive(installationId)
        ) {
          return false;
        }
        counts.purged = purgeRepos(
          tx,
          installationId,
          tx
            .select({ id: repos.id, createdAt: repos.createdAt })
            .from(repos)
            .where(eq(repos.installationId, installationId))
            .all()
            .filter(
              (row) =>
                gone.has(row.id) &&
                !listedIds.has(row.id) &&
                row.createdAt <= startedAt,
            )
            .map((row) => row.id),
        );
        for (const repo of listed) {
          const identity = {
            installationId,
            owner: repo.owner,
            name: repo.name,
            private: repo.private,
            updatedAt: at,
          };
          const outcome = outcomes.get(repo.nodeId);
          const decided =
            outcome === undefined
              ? {}
              : outcome.state === "skipped"
                ? {
                    syncState: "skipped" as const,
                    syncDetail: outcome.detail,
                    openIssueCount: 0,
                  }
                : outcome.state === "ready"
                  ? {
                      syncState: "ready" as const,
                      syncDetail: null,
                      openIssueCount: 0,
                      lastFullSyncAt: at,
                      reconcileSince: new Date(at).toISOString(),
                      restEtag: null,
                    }
                  : {
                      syncState: "pending" as const,
                      syncDetail: null,
                      openIssueCount: outcome.openIssues,
                    };
          if (outcome !== undefined) counts[outcome.state]++;
          if (stored.has(repo.nodeId)) {
            // The outcome was decided from the state read before the GitHub
            // calls; a repo a sync or a webhook moved on since keeps its state.
            const state = tx
              .select({ syncState: repos.syncState })
              .from(repos)
              .where(eq(repos.id, repo.nodeId))
              .get()?.syncState;
            const fields =
              state === "pending" || state === "skipped" ? decided : {};
            try {
              tx.update(repos)
                .set({ ...identity, ...fields })
                .where(eq(repos.id, repo.nodeId))
                .run();
            } catch (error) {
              if (!isUniqueViolation(error)) throw error;
              logger.warn(
                { installationId, repo: `${repo.owner}/${repo.name}` },
                "a repository that clashes with a stored repository kept its stored name",
              );
              tx.update(repos)
                .set({
                  installationId,
                  private: repo.private,
                  updatedAt: at,
                  ...fields,
                })
                .where(eq(repos.id, repo.nodeId))
                .run();
            }
          } else {
            const inserted = tx
              .insert(repos)
              .values({
                id: repo.nodeId,
                databaseId: repo.id,
                syncState: "pending",
                openIssueCount: 0,
                createdAt: at,
                ...identity,
                ...decided,
              })
              .onConflictDoNothing()
              .run();
            if (inserted.changes === 0) {
              logger.warn(
                { installationId, repo: `${repo.owner}/${repo.name}` },
                "a repository that clashes with a stored repository was left out",
              );
            } else counts.created++;
          }
        }
        return true;
      });
      if (!written) {
        logger.info(
          { installationId },
          "repository discovery skipped: the installation stopped being active",
        );
        return "skipped";
      }
      logger.info(
        { installationId, listed: listed.length, ...counts },
        "repositories discovered",
      );
      onPending(
        db
          .select({ id: repos.id, installationId: repos.installationId })
          .from(repos)
          .where(
            and(
              eq(repos.installationId, installationId),
              eq(repos.syncState, "pending"),
            ),
          )
          .all(),
      );
      return "discovered";
    },
  };
}

/** Enqueues discovery for the installation; one pending job per installation. */
export function enqueueDiscovery(jobs: Jobs, installationId: number): boolean {
  return jobs.enqueue(
    DISCOVERY_JOB,
    { installationId },
    { key: String(installationId), installationId },
  );
}

/**
 * Registers the job that runs {@link Discovery.discover} for one installation.
 * A run that fails is logged at `warn` with the installation id and not
 * thrown: the scheduled discovery of {@link registerDiscoverySchedule} runs it
 * again.
 */
export function registerDiscoveryJob(
  jobs: Jobs,
  discovery: Discovery,
  logger: Logger,
): void {
  jobs.register<{ installationId: number }>(
    DISCOVERY_JOB,
    async ({ installationId }) => {
      try {
        await discovery.discover(installationId);
      } catch (error) {
        logger.warn(
          { err: error, installationId },
          "repository discovery failed; it runs again at the next scheduled discovery",
        );
      }
    },
  );
}

/**
 * Registers the job that enqueues discovery for every active, non-suspended
 * installation, and schedules it every `intervalMs` (SPEC §6.1), so an
 * installation whose discovery failed, or that a restart or an access
 * computation did not reach, is discovered again within a day.
 */
export function registerDiscoverySchedule(
  jobs: Jobs,
  db: Pick<Db, "select">,
  isActive: (installationId: number) => boolean,
  intervalMs: number = DISCOVERY_INTERVAL_MS,
): void {
  jobs.register(DISCOVERY_SCHEDULE_JOB, () => {
    for (const { id } of db
      .select({ id: installations.id })
      .from(installations)
      .where(eq(installations.suspended, false))
      .all()) {
      if (isActive(id)) enqueueDiscovery(jobs, id);
    }
  });
  jobs.schedule(DISCOVERY_SCHEDULE_JOB, intervalMs);
}
