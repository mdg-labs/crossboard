import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { GithubBudgets, RateBudget } from "../github/index.js";
import type { PauseRule } from "./queue.js";

const { installations } = schema;

/** A background job waits for the reset below this share of the budget (SPEC §6.5). */
export const BACKGROUND_BUDGET_FLOOR = 0.1;
/** How long a job waits when the budget is low but GitHub reported no reset. */
export const UNKNOWN_RESET_RETRY_MS = 5 * 60_000;

export interface InstallationPauseOptions {
  db: Pick<Db, "select">;
  budgets: GithubBudgets;
  /**
   * Jobs the rule never pauses: the ones that apply the events that lift a
   * suspension or remove the installation, which a suspended installation
   * would otherwise keep from ever running.
   */
  exemptJobs?: Iterable<string>;
  now?: () => number;
}

/**
 * The rule the jobs interface applies to every background job that names an
 * installation (SPEC §6.2, §6.5): a suspended installation's job is dropped,
 * since the discovery and reconciliation that `unsuspend` enqueues resume its
 * work, and a job of an installation below
 * {@link BACKGROUND_BUDGET_FLOOR} of either budget waits for the reset. A
 * budget that is unknown (after a restart, before the first call) or whose
 * reset has passed does not pause anything, so work is never held on a figure
 * that cannot be refreshed. Reading the suspended flag may throw; the jobs
 * interface then defers the job.
 */
export function createInstallationPause(
  options: InstallationPauseOptions,
): PauseRule {
  const { db, budgets, now = Date.now } = options;
  const exempt = new Set(options.exemptJobs);

  const isSuspended = (installationId: number): boolean =>
    db
      .select({ suspended: installations.suspended })
      .from(installations)
      .where(eq(installations.id, installationId))
      .get()?.suspended ?? false;

  // The delay until a spent budget refills, or undefined when it is not spent.
  const waitFor = (budget: RateBudget | null, at: number) => {
    if (budget === null) return undefined;
    if (budget.resetAt !== null && budget.resetAt <= at) return undefined;
    const low =
      budget.limit === null
        ? budget.remaining <= 0
        : budget.remaining < budget.limit * BACKGROUND_BUDGET_FLOOR;
    if (!low) return undefined;
    return budget.resetAt === null
      ? UNKNOWN_RESET_RETRY_MS
      : budget.resetAt - at;
  };

  return ({ name, installationId }) => {
    if (exempt.has(name)) return { action: "run" };
    if (isSuspended(installationId)) {
      return { action: "drop", reason: "installation suspended" };
    }
    const at = now();
    const known = budgets.get(installationId);
    const waits = [waitFor(known.rest, at), waitFor(known.graphql, at)].filter(
      (wait) => wait !== undefined,
    );
    if (waits.length === 0) return { action: "run" };
    return {
      action: "defer",
      delayMs: Math.max(...waits),
      reason: "installation budget below 10% until its reset",
    };
  };
}
