import { inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { Allowlist } from "../auth/sign-in/index.js";
import { schema, type Db } from "../db/index.js";
import { activeInstallationIds } from "./active.js";
import { purgeInstallations } from "./purge.js";

const { installations, repos } = schema;

/**
 * Purges the repos of every recorded installation outside the active set
 * (SPEC FR-3, §8.2). An access computation sees an installation go inactive
 * only when its own run changes the active set, so one an allowlist change
 * deactivated between two runs is purged here, at startup, before discovery or
 * any sync is enqueued. One transaction reads the active set and purges, so a
 * failure leaves every repo in place. Returns the installation ids whose repos
 * were removed.
 */
export function purgeInactiveInstallations(
  db: Db,
  allowlist: Allowlist,
  logger: Logger,
): number[] {
  const { purgedInstallations, purgedRepos } = db.transaction((tx) => {
    const active = activeInstallationIds(tx, allowlist);
    const inactive = tx
      .select({ id: installations.id })
      .from(installations)
      .all()
      .map(({ id }) => id)
      .filter((id) => !active.has(id));
    const withRepos = new Set(
      inactive.length === 0
        ? []
        : tx
            .selectDistinct({ id: repos.installationId })
            .from(repos)
            .where(inArray(repos.installationId, inactive))
            .all()
            .map(({ id }) => id),
    );
    const purgedInstallations = inactive.filter((id) => withRepos.has(id));
    return {
      purgedInstallations,
      purgedRepos: purgeInstallations(tx, purgedInstallations),
    };
  });
  if (purgedInstallations.length > 0) {
    logger.info(
      { installations: purgedInstallations, repos: purgedRepos },
      "purged the repositories of inactive installations",
    );
  }
  return purgedInstallations;
}
