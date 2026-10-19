import type { Allowlist } from "../auth/sign-in/index.js";
import type { Db } from "../db/index.js";
import { activeInstallationIds } from "./active.js";
import { purgeInstallations } from "./purge.js";

export interface ActiveSetChange<T> {
  result: T;
  /** Installations the change made active (SPEC FR-3). */
  activated: number[];
  /** Installations it made inactive; their repos are purged (SPEC §8.2). */
  deactivated: number[];
}

/**
 * Runs `change` and derives the active set again around it, in one
 * transaction: the repos of the installations the change deactivated are
 * purged with it, so a failure leaves the active set and its repos as they
 * were. Starting repository discovery for the activated ones is the caller's.
 */
export function changeActiveSet<T>(
  db: Db,
  allowlist: Allowlist,
  change: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => T,
): ActiveSetChange<T> {
  return db.transaction((tx) => {
    const before = activeInstallationIds(tx, allowlist);
    const result = change(tx);
    const after = activeInstallationIds(tx, allowlist);
    const deactivated = [...before].filter((id) => !after.has(id));
    purgeInstallations(tx, deactivated);
    return {
      result,
      activated: [...after].filter((id) => !before.has(id)),
      deactivated,
    };
  });
}
