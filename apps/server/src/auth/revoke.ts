import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

/**
 * Deletes the tokens and sessions of the user with this GitHub id (SPEC FR-7),
 * in one transaction. Resolves to false for a user this instance does not know.
 */
export function revokeUserByGithubId(db: Db, githubId: number): boolean {
  return db.transaction((tx) => {
    const user = tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.githubId, githubId))
      .get();
    if (user === undefined) return false;
    tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id)).run();
    tx.delete(schema.userTokens)
      .where(eq(schema.userTokens.userId, user.id))
      .run();
    return true;
  });
}
