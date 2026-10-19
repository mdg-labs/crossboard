import { inArray, or } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { CHUNK, chunks, deleteUnusedLabels } from "./issue-data.js";

const { issueDeps, issueRefs, issues } = schema;

/**
 * Why an issue stops being synced: `closed` leaves it known to the issues it
 * blocks; `gone` (deleted, transferred or no longer readable) forgets it.
 */
export type RemovalReason = "closed" | "gone";

export interface RemovalOptions {
  db: Db;
  /** Refetches synced issues by node id (SPEC §6.2); resolves to its GraphQL cost. */
  refetch: (ids: string[]) => Promise<number>;
}

export interface Removal {
  /**
   * Removes issues by the SPEC §8.2 rules, the one way every path does it
   * (sync, webhooks, reconciliation). Each issue's `issues` row goes, with its
   * labels, assignees and details, and so do the `issue_deps` rows where it is
   * the blocked side. Then:
   *
   * - `closed`: its `issue_refs.state` becomes `CLOSED`; the rows where it is
   *   the blocking side stay, so the issues it blocked show it struck through.
   * - `gone`: its ref and every `issue_deps` row that mentions it are deleted,
   *   and every synced issue on the other side of those rows is refetched
   *   first, so its totals and not-accessible count stay consistent. A failed
   *   refetch throws before anything is deleted, so the removal can be retried.
   *
   * An issue already being removed by an enclosing call is left to it.
   * Resolves to the GraphQL cost of the refetch it needed.
   */
  remove(ids: readonly string[], reason: RemovalReason): Promise<number>;
}

export function createRemoval({ db, refetch }: RemovalOptions): Removal {
  // A refetch can find the other side gone as well, and the two removals
  // would each wait on the other.
  const removing = new Set<string>();

  /** The synced issues on the other side of any edge that mentions one of the ids. */
  function counterparts(ids: readonly string[]): string[] {
    const found = new Set<string>();
    for (const part of chunks(ids, CHUNK)) {
      for (const edge of db
        .select()
        .from(issueDeps)
        .where(
          or(
            inArray(issueDeps.blockedId, part),
            inArray(issueDeps.blockingId, part),
          ),
        )
        .all()) {
        found.add(edge.blockedId);
        found.add(edge.blockingId);
      }
    }
    const candidates = [...found].filter((id) => !removing.has(id));
    const synced: string[] = [];
    for (const part of chunks(candidates, CHUNK)) {
      synced.push(
        ...db
          .select({ id: issues.id })
          .from(issues)
          .where(inArray(issues.id, part))
          .all()
          .map((row) => row.id),
      );
    }
    return synced;
  }

  return {
    async remove(requested, reason) {
      const ids = [...new Set(requested)].filter((id) => !removing.has(id));
      if (ids.length === 0) return 0;
      for (const id of ids) removing.add(id);
      try {
        let cost = 0;
        if (reason === "gone") {
          const other = counterparts(ids);
          if (other.length > 0) cost = await refetch(other);
        }
        db.transaction((tx) => {
          const repoIds = new Set<string>();
          for (const part of chunks(ids, CHUNK)) {
            for (const row of tx
              .select({ repoId: issues.repoId })
              .from(issues)
              .where(inArray(issues.id, part))
              .all()) {
              repoIds.add(row.repoId);
            }
            tx.delete(issues).where(inArray(issues.id, part)).run();
            if (reason === "closed") {
              tx.delete(issueDeps)
                .where(inArray(issueDeps.blockedId, part))
                .run();
              tx.update(issueRefs)
                .set({ state: "CLOSED" })
                .where(inArray(issueRefs.id, part))
                .run();
            } else {
              tx.delete(issueDeps)
                .where(
                  or(
                    inArray(issueDeps.blockedId, part),
                    inArray(issueDeps.blockingId, part),
                  ),
                )
                .run();
              tx.delete(issueRefs).where(inArray(issueRefs.id, part)).run();
            }
          }
          for (const repoId of repoIds) deleteUnusedLabels(tx, repoId);
        });
        return cost;
      } finally {
        for (const id of ids) removing.delete(id);
      }
    },
  };
}
