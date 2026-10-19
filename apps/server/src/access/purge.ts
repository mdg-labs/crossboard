import { and, eq, inArray, type SQL } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

const { issueDeps, issues, repos } = schema;

// Keeps one statement under SQLite's bound-parameter limit.
const CHUNK = 200;

type Writer = Pick<Db, "select" | "delete">;

/** Deletes the repos `where` selects, and the dependency rows their issues block. */
function purge(db: Writer, where: SQL | undefined): number {
  const repoIds = db.select({ id: repos.id }).from(repos).where(where);
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
  return db.delete(repos).where(where).returning({ id: repos.id }).all().length;
}

/**
 * Purges the installations' repos (SPEC §8.2): their issues, labels and access
 * rows go with them through the foreign keys, and so do the dependency rows
 * whose blocked side is one of those issues. Boards and saved views hold only
 * filter text and are never touched, and the installation rows stay, since an
 * installation is recorded whether or not it is active (SPEC FR-3). Returns
 * the number of repos removed.
 */
export function purgeInstallations(
  db: Writer,
  installationIds: readonly number[],
): number {
  if (installationIds.length === 0) return 0;
  return purge(db, inArray(repos.installationId, [...installationIds]));
}

/**
 * Purges the given repos the same way, but only those that belong to
 * `installationId`: a repo of any other installation is left alone, whatever
 * the ids say. Call it inside a transaction, since it takes more than one
 * statement. Returns the number of repos removed.
 */
export function purgeRepos(
  db: Writer,
  installationId: number,
  repoIds: readonly string[],
): number {
  let removed = 0;
  for (let index = 0; index < repoIds.length; index += CHUNK) {
    removed += purge(
      db,
      and(
        eq(repos.installationId, installationId),
        inArray(repos.id, repoIds.slice(index, index + CHUNK)),
      ),
    );
  }
  return removed;
}
