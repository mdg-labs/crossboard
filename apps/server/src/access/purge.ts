import { inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

const { issueDeps, issues, repos } = schema;

/**
 * Purges the installations' repos (SPEC §8.2): their issues, labels and access
 * rows go with them through the foreign keys, and so do the dependency rows
 * whose blocked side is one of those issues. Boards and saved views hold only
 * filter text and are never touched, and the installation rows stay, since an
 * installation is recorded whether or not it is active (SPEC FR-3). Returns
 * the number of repos removed.
 */
export function purgeInstallations(
  db: Pick<Db, "select" | "delete">,
  installationIds: readonly number[],
): number {
  if (installationIds.length === 0) return 0;
  const repoIds = db
    .select({ id: repos.id })
    .from(repos)
    .where(inArray(repos.installationId, [...installationIds]));
  db.delete(issueDeps)
    .where(
      inArray(
        issueDeps.blockedId,
        db
          .select({ id: issues.id })
          .from(issues)
          .where(inArray(issues.repoId, repoIds)),
      ),
    )
    .run();
  return db
    .delete(repos)
    .where(inArray(repos.installationId, [...installationIds]))
    .returning({ id: repos.id })
    .all().length;
}
