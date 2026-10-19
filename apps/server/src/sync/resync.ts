import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Allowlist } from "../auth/sign-in/index.js";
import { activeInstallationIds } from "../access/index.js";
import { schema, type Db } from "../db/index.js";
import type { Jobs } from "../jobs/index.js";
import { enqueueSync } from "./sync.js";

const { installations, repos } = schema;

export const RESYNC_JOB = "sync.resync";
export const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the scheduler looks for repos whose daily resync is due. */
export const RESYNC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Where in the day a repo's resync starts, as an offset from the epoch modulo
 * 24 h. It is derived from the repo's id, so it is spread over the day, the
 * same across restarts, and needs no stored state.
 */
export function resyncSlot(repoId: string): number {
  return createHash("sha256").update(repoId).digest().readUInt32BE(0) % DAY_MS;
}

/**
 * Whether a repo's daily resync is due (SPEC §6.3): its slot has come round
 * since the last time it was fully synced. A repo with no such time is due.
 */
export function resyncDue(
  repoId: string,
  lastSyncedAt: number | null,
  at: number,
): boolean {
  if (lastSyncedAt === null) return true;
  const sinceSlot = (((at - resyncSlot(repoId)) % DAY_MS) + DAY_MS) % DAY_MS;
  return lastSyncedAt < at - sinceSlot;
}

/**
 * Registers the job that queues the sync of every `ready` repo of an active,
 * non-suspended installation whose daily resync is due, and schedules it every
 * {@link RESYNC_INTERVAL_MS}. A repo whose last sync failed (`error`) counts
 * from the time of that failure, so it is tried again at its next slot. The
 * resync is the sync job itself: it replaces the repo's issues, removes the
 * ones no longer returned and prunes the unreferenced refs.
 */
export function registerResyncJob(
  jobs: Jobs,
  db: Db,
  allowlist: Allowlist,
  now: () => number = Date.now,
): void {
  jobs.register(RESYNC_JOB, () => {
    const at = now();
    const active = activeInstallationIds(db, allowlist);
    const candidates = db
      .select({
        id: repos.id,
        installationId: repos.installationId,
        syncState: repos.syncState,
        lastFullSyncAt: repos.lastFullSyncAt,
        updatedAt: repos.updatedAt,
      })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(
        and(
          inArray(repos.syncState, ["ready", "error"]),
          eq(installations.suspended, false),
        ),
      )
      .all();
    for (const repo of candidates) {
      if (!active.has(repo.installationId)) continue;
      const last =
        repo.syncState === "error" ? repo.updatedAt : repo.lastFullSyncAt;
      if (resyncDue(repo.id, last, at)) enqueueSync(jobs, repo);
    }
  });
  jobs.schedule(RESYNC_JOB, RESYNC_INTERVAL_MS);
}
