import { gt } from "drizzle-orm";
import type { Logger } from "pino";
import { schema, type Db } from "../db/index.js";
import type { Jobs } from "../jobs/index.js";
import type { Access } from "./compute.js";

export const ACCESS_JOB = "access.compute";
export const ACCESS_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Recomputes the access of every user with a live session (SPEC FR-8). A user
 * whose token GitHub rejects with 401 is signed out (SPEC FR-7). One user's
 * failure is logged and does not stop the others.
 */
export async function computeLiveSessionAccess(
  access: Pick<Access, "compute">,
  db: Pick<Db, "selectDistinct">,
  logger: Logger,
  now: () => number = Date.now,
): Promise<void> {
  const users = db
    .selectDistinct({ userId: schema.sessions.userId })
    .from(schema.sessions)
    .where(gt(schema.sessions.expiresAt, now()))
    .all();
  for (const { userId } of users) {
    try {
      await access.compute(userId, { revokeRejected: true });
    } catch (error) {
      logger.error({ err: error, userId }, "computing user access failed");
    }
  }
}

/**
 * Registers the job that recomputes the access of every user with a live
 * session, and schedules it every 60 minutes (SPEC FR-8).
 */
export function registerAccessJob(
  jobs: Jobs,
  access: Access,
  db: Db,
  logger: Logger,
  now: () => number = Date.now,
): void {
  jobs.register(ACCESS_JOB, () =>
    computeLiveSessionAccess(access, db, logger, now),
  );
  jobs.schedule(ACCESS_JOB, ACCESS_INTERVAL_MS);
}
