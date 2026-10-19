import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { Jobs } from "../../jobs/index.js";
import { cleanupSessions } from "./store.js";

export const SESSION_CLEANUP_JOB = "sessions.cleanup";
export const SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Registers the daily job that drops expired sessions and orphaned tokens. */
export function registerSessionCleanup(
  jobs: Jobs,
  db: Db,
  logger: Logger,
): void {
  jobs.register(SESSION_CLEANUP_JOB, () => {
    const removed = cleanupSessions(db);
    logger.info(
      { sessions: removed.sessions, tokens: removed.tokens },
      "expired sessions cleaned up",
    );
  });
  jobs.schedule(SESSION_CLEANUP_JOB, SESSION_CLEANUP_INTERVAL_MS);
}

/**
 * Queues one cleanup run for the process start: the daily timer first fires a
 * day after `jobs.start()`, which a frequently restarted instance never
 * reaches. The run is synchronous, so it cannot overlap a scheduled run.
 */
export function enqueueSessionCleanupAtStart(jobs: Jobs): boolean {
  return jobs.enqueue(SESSION_CLEANUP_JOB, undefined, { key: "[startup]" });
}
