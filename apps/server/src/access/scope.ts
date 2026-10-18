import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema, type Db } from "../db/index.js";

const { repos, userRepoAccess } = schema;

type Reader = Pick<Db, "select">;

/** The ids of the repos `userId` may see, as a subquery. */
const repoIdsOf = (db: Reader, userId: number) =>
  db
    .select({ repoId: userRepoAccess.repoId })
    .from(userRepoAccess)
    .where(eq(userRepoAccess.userId, userId));

/**
 * A condition that restricts a query to the repos in the user's access
 * (SPEC FR-9): `where(inUserAccess(db, userId, issues.repoId))`. Every API
 * query over per-repo data carries it.
 */
export function inUserAccess(
  db: Reader,
  userId: number,
  repoIdColumn: AnySQLiteColumn,
): SQL {
  return inArray(repoIdColumn, repoIdsOf(db, userId));
}

/** The repos in the user's access, optionally narrowed further. */
export function accessibleRepos(
  db: Reader,
  userId: number,
  extra?: SQL,
): (typeof repos.$inferSelect)[] {
  return db
    .select()
    .from(repos)
    .where(and(inUserAccess(db, userId, repos.id), extra))
    .all();
}

/** Whether the repo is in the user's access. */
export function hasRepoAccess(
  db: Reader,
  userId: number,
  repoId: string,
): boolean {
  return (
    db
      .select({ repoId: userRepoAccess.repoId })
      .from(userRepoAccess)
      .where(
        and(
          eq(userRepoAccess.userId, userId),
          eq(userRepoAccess.repoId, repoId),
        ),
      )
      .get() !== undefined
  );
}
