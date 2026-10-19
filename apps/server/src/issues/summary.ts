import { and, asc, eq, inArray } from "drizzle-orm";
import { accessibleRepos, inUserAccess } from "../access/index.js";
import type { IssueRelationEntry, IssueSummary } from "../api/schemas.js";
import { schema, type Db } from "../db/index.js";
import { loadAccessibleIssues, type IssueLocator } from "./filterable.js";
import { loadAncestors } from "./hierarchy.js";

const { issueDeps, issueRefs, issues } = schema;

type Ref = typeof issueRefs.$inferSelect;

const splitFullName = (fullName: string) => {
  const slash = fullName.indexOf("/");
  return {
    owner: fullName.slice(0, slash),
    repo: fullName.slice(slash + 1),
  };
};

/**
 * The summary of one synced issue in the user's access (SPEC §7.4): the issue
 * item with its complete `blockedBy` / `blocking` lists (FR-23) and the
 * parent's title and state and the ancestor chain (FR-40). `null` when the
 * issue is not synced or not in the user's access. A relation or parent in a repo outside the access is never
 * named; it only counts toward `notAccessible` (FR-24, §9.1).
 */
export function loadIssueSummary(
  db: Db,
  userId: number,
  locator: IssueLocator,
): IssueSummary | null {
  const found = loadAccessibleIssues(db, userId, locator)[0];
  if (found === undefined) return null;
  const { item } = found;

  const readable = new Set(
    accessibleRepos(db, userId).map((repo) =>
      `${repo.owner}/${repo.name}`.toLowerCase(),
    ),
  );
  const visible = (ref: Ref) => readable.has(ref.repoFullName.toLowerCase());

  const blockers = db
    .select({ ref: issueRefs })
    .from(issueDeps)
    .innerJoin(issueRefs, eq(issueDeps.blockingId, issueRefs.id))
    .where(eq(issueDeps.blockedId, item.id))
    .orderBy(asc(issueRefs.repoFullName), asc(issueRefs.number))
    .all()
    .map((row) => row.ref)
    .filter(visible);
  const blocked = db
    .select({ ref: issueRefs })
    .from(issueDeps)
    .innerJoin(issueRefs, eq(issueDeps.blockedId, issueRefs.id))
    .where(eq(issueDeps.blockingId, item.id))
    .orderBy(asc(issueRefs.repoFullName), asc(issueRefs.number))
    .all()
    .map((row) => row.ref)
    .filter(visible);

  const parentRow = db
    .select({ ref: issueRefs })
    .from(issues)
    .innerJoin(issueRefs, eq(issues.parentId, issueRefs.id))
    .where(eq(issues.id, item.id))
    .get();
  const parentRef =
    parentRow !== undefined && visible(parentRow.ref) ? parentRow.ref : null;

  const ids = [...blockers, ...blocked].map((ref) => ref.id);
  const synced = new Set(
    ids.length === 0
      ? []
      : db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              inArray(issues.id, ids),
              inUserAccess(db, userId, issues.repoId),
            ),
          )
          .all()
          .map((row) => row.id),
  );
  const entry = (ref: Ref): IssueRelationEntry => ({
    ...splitFullName(ref.repoFullName),
    number: ref.number,
    title: ref.title,
    state: ref.state,
    url: ref.url,
    synced: synced.has(ref.id),
  });

  return {
    ...item,
    parent:
      item.parent === null || parentRef === null
        ? null
        : {
            ...item.parent,
            title: parentRef.title,
            state: parentRef.state,
          },
    ancestors: loadAncestors(db, userId, item),
    blockedBy: { ...item.blockedBy, items: blockers.map(entry) },
    blocking: { ...item.blocking, items: blocked.map(entry) },
  };
}
