import { inArray, or } from "drizzle-orm";
import { schema } from "../db/index.js";
import {
  CHUNK,
  chunks,
  type IssueData,
  type RefData,
  type Tx,
} from "./issue-data.js";

const { issueDeps, issueRefs } = schema;

/**
 * Stores the issues' parents and dependency edges (SPEC §8.1) for the fetched
 * issues `data` of the repo `repoFullName`: an `issue_refs` row for every
 * parent and every issue on either side of a dependency, synced or not (a
 * synced issue gets one too once it has an edge), and one `issue_deps` row per
 * readable edge, the two sides' lists deduplicated.
 *
 * Both lists of a fetched issue are paged in full, so every stored edge that
 * touches one of those issues is replaced, cross-repo ones included. An edge
 * whose end in this repo was not fetched (a closed issue's, for example) is
 * kept: the sync of the repo on its other side owns it. With `issueIds` only
 * those of the fetched issues are replaced.
 */
export function writeRelations(
  tx: Tx,
  repoFullName: string,
  data: readonly IssueData[],
  at: number,
  issueIds?: readonly string[],
): void {
  const wanted = issueIds === undefined ? undefined : new Set(issueIds);
  const fetched = data
    .map((issue) => issue.id)
    .filter((id) => wanted === undefined || wanted.has(id));
  for (const part of chunks(fetched, CHUNK)) {
    tx.delete(issueDeps)
      .where(
        or(
          inArray(issueDeps.blockedId, part),
          inArray(issueDeps.blockingId, part),
        ),
      )
      .run();
  }

  const refs = new Map<string, RefData>();
  const edges = new Map<string, { blockedId: string; blockingId: string }>();
  const edge = (blockedId: string, blockingId: string) => {
    edges.set(`${blockedId}\u0000${blockingId}`, { blockedId, blockingId });
  };
  for (const issue of data) {
    if (issue.parent !== null) refs.set(issue.parent.id, issue.parent);
    for (const other of [...issue.blockedBy, ...issue.blocking]) {
      refs.set(other.id, other);
    }
    for (const blocker of issue.blockedBy) edge(issue.id, blocker.id);
    for (const blocked of issue.blocking) edge(blocked.id, issue.id);
  }
  // A synced issue's own data outranks how another issue names it.
  for (const issue of data) {
    if (issue.blockedBy.length > 0 || issue.blocking.length > 0) {
      refs.set(issue.id, {
        id: issue.id,
        repoFullName,
        number: issue.number,
        title: issue.title,
        state: "OPEN",
        url: issue.url,
      });
    }
  }

  for (const ref of refs.values()) {
    tx.insert(issueRefs)
      .values({ ...ref, seenAt: at })
      .onConflictDoUpdate({
        target: issueRefs.id,
        set: {
          repoFullName: ref.repoFullName,
          number: ref.number,
          title: ref.title,
          state: ref.state,
          url: ref.url,
          seenAt: at,
        },
      })
      .run();
  }
  for (const part of chunks([...edges.values()], CHUNK)) {
    tx.insert(issueDeps).values(part).onConflictDoNothing().run();
  }
}
