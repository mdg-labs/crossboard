import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { accessibleRepos, activeInstallationIds } from "../access/index.js";
import type { SessionEnv } from "../auth/sessions/index.js";
import type { Setup } from "../auth/setup/index.js";
import { schema, type Db } from "../db/index.js";
import type { GithubBudgets, RateBudget } from "../github/index.js";
import type { Jobs } from "../jobs/index.js";
import { enqueueReconcile } from "../sync/reconcile.js";
import type { ApiErrorBody } from "./errors.js";

/** The least time between two refreshes by one user (SPEC FR-45). */
export const REFRESH_INTERVAL_MS = 60_000;

export interface SyncOptions {
  db: Db;
  setup: Setup;
  budgets: GithubBudgets;
  jobs: Jobs;
  now?: () => number;
}

const newest = (...times: (number | null)[]): number | null => {
  const known = times.filter((time) => time !== null);
  return known.length === 0 ? null : Math.max(...known);
};

const toBudget = (budget: RateBudget | null) =>
  budget === null
    ? null
    : {
        remaining: budget.remaining,
        limit: budget.limit,
        resetAt: budget.resetAt,
      };

/**
 * `GET /api/sync` (SPEC FR-45, FR-46, §7.4): the session user's accessible
 * repos with their sync state and last sync time, the oldest of those times
 * among the `ready` ones (`syncedAt`, `null` when none is ready or one has no
 * time), and the budget of each active installation the user reaches (`null`
 * until a call reports it). Nothing is read for a repo outside `user_repo_access`.
 *
 * `POST /api/sync/refresh`: enqueues a reconciliation (SPEC §6.3) of the
 * user's ready repos in active installations, at most once per
 * {@link REFRESH_INTERVAL_MS} per user, tracked in memory; `429` with the
 * remaining seconds otherwise.
 */
export function createSyncRoutes({
  db,
  setup,
  budgets,
  jobs,
  now = Date.now,
}: SyncOptions) {
  const lastRefresh = new Map<number, number>();

  return new Hono<SessionEnv>()
    .get("/sync", (c) => {
      const { userId } = c.var.session;
      const repos = accessibleRepos(db, userId)
        .map((repo) => ({
          owner: repo.owner,
          name: repo.name,
          state: repo.syncState,
          detail: repo.syncDetail,
          lastSyncedAt: newest(repo.lastFullSyncAt, repo.lastReconciledAt),
        }))
        .sort(
          (a, b) =>
            a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name),
        );
      const ready = repos.filter((repo) => repo.state === "ready");
      const syncedAt =
        ready.length === 0 || ready.some((repo) => repo.lastSyncedAt === null)
          ? null
          : Math.min(...ready.map((repo) => repo.lastSyncedAt as number));

      const active = activeInstallationIds(db, setup.allowlist);
      const installations = db
        .select({
          id: schema.installations.id,
          accountLogin: schema.installations.accountLogin,
        })
        .from(schema.userInstallations)
        .innerJoin(
          schema.installations,
          eq(schema.userInstallations.installationId, schema.installations.id),
        )
        .where(eq(schema.userInstallations.userId, userId))
        .orderBy(asc(schema.installations.accountLogin))
        .all()
        .filter((installation) => active.has(installation.id))
        .map((installation) => {
          const budget = budgets.get(installation.id);
          return {
            ...installation,
            rest: toBudget(budget.rest),
            graphql: toBudget(budget.graphql),
          };
        });

      return c.json({ syncedAt, repos, installations });
    })
    .post("/sync/refresh", (c) => {
      const { userId } = c.var.session;
      const at = now();
      for (const [id, last] of lastRefresh) {
        if (at - last >= REFRESH_INTERVAL_MS) lastRefresh.delete(id);
      }
      const last = lastRefresh.get(userId);
      if (last !== undefined) {
        const retryAfter = Math.max(
          1,
          Math.ceil((REFRESH_INTERVAL_MS - (at - last)) / 1000),
        );
        const body: ApiErrorBody & { error: { retryAfter: number } } = {
          error: {
            code: "rate_limited",
            message: `Refresh again in ${String(retryAfter)} s`,
            retryAfter,
          },
        };
        c.header("Retry-After", String(retryAfter));
        return c.json(body, 429);
      }

      const active = activeInstallationIds(db, setup.allowlist);
      const targets = accessibleRepos(db, userId).filter(
        (repo) => repo.syncState === "ready" && active.has(repo.installationId),
      );
      for (const repo of targets) enqueueReconcile(jobs, repo);
      lastRefresh.set(userId, at);
      return c.json({ repos: targets.length }, 202);
    });
}
