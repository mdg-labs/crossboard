import { count, eq, not, sql } from "drizzle-orm";
import { inUserAccess } from "../access/index.js";
import type {
  IssueItem,
  IssueRelationEntry,
  SubIssue,
  SubIssueNode,
} from "../api/schemas.js";
import { schema, type Db } from "../db/index.js";
import { loadAccessibleIssues } from "./filterable.js";
import { sortIssues } from "./sort.js";

const { issueRefs, issues } = schema;

const issueKey = (owner: string, repo: string, number: number) =>
  `${owner}/${repo}#${String(number)}`.toLowerCase();

/**
 * The parent chain of one synced issue, nearest first (SPEC FR-40). It
 * follows the parent of each issue across synced issues in the viewer's
 * access, lists a parent that is not synced with `synced: false` and stops
 * there, stops at a parent outside the access (which `item.parent` already
 * leaves out, FR-24, §9.1) and ends before an issue it has already visited.
 */
export function loadAncestors(
  db: Db,
  userId: number,
  item: IssueItem,
): IssueRelationEntry[] {
  const ancestors: IssueRelationEntry[] = [];
  const visited = new Set([
    issueKey(item.repo.owner, item.repo.name, item.number),
  ]);
  let current = item;
  for (;;) {
    const parent = current.parent;
    if (parent === null) break;
    const key = issueKey(parent.owner, parent.repo, parent.number);
    if (visited.has(key)) break;
    visited.add(key);

    const synced = loadAccessibleIssues(db, userId, parent)[0];
    if (synced !== undefined) {
      ancestors.push({
        owner: synced.item.repo.owner,
        repo: synced.item.repo.name,
        number: synced.item.number,
        title: synced.item.title,
        state: "OPEN",
        url: synced.item.url,
        synced: true,
      });
      current = synced.item;
      continue;
    }
    const ref = db
      .select()
      .from(issueRefs)
      .where(
        sql`lower(${issueRefs.repoFullName}) = ${`${parent.owner}/${parent.repo}`.toLowerCase()} and ${issueRefs.number} = ${parent.number}`,
      )
      .get();
    if (ref !== undefined) {
      ancestors.push({
        owner: parent.owner,
        repo: parent.repo,
        number: ref.number,
        title: ref.title,
        state: ref.state,
        url: ref.url,
        synced: false,
      });
    }
    break;
  }
  return ancestors;
}

/**
 * Turns the first sub-issues GitHub listed for an issue into the tree of
 * SPEC FR-40. A listed sub-issue that is synced in the viewer's access gets
 * its progress and, from the parent of each synced issue, its synced
 * sub-issues, recursively and without a depth limit. Nothing here asks
 * GitHub. Synced sub-issues outside the viewer's access are counted in their
 * parent's `notAccessible` and never named, and an issue that already
 * appears in the tree (or is the root) is not listed again, so a parent
 * cycle ends before the repeat.
 */
export function buildSubIssueTree(
  db: Db,
  userId: number,
  root: { owner: string; repo: string; number: number },
  listed: readonly SubIssue[],
): SubIssueNode[] {
  if (listed.length === 0) return [];

  const syncedByKey = new Map<string, IssueItem>();
  const childrenOf = new Map<string, IssueItem[]>();
  const accessible = sortIssues(loadAccessibleIssues(db, userId), "repo-asc");
  for (const { item } of accessible) {
    syncedByKey.set(
      issueKey(item.repo.owner, item.repo.name, item.number),
      item,
    );
  }
  for (const { item } of accessible) {
    if (item.parent === null) continue;
    const parentKey = issueKey(
      item.parent.owner,
      item.parent.repo,
      item.parent.number,
    );
    const siblings = childrenOf.get(parentKey);
    if (siblings === undefined) childrenOf.set(parentKey, [item]);
    else siblings.push(item);
  }

  const hiddenOf = new Map<string, number>();
  for (const row of db
    .select({
      repoFullName: issueRefs.repoFullName,
      number: issueRefs.number,
      hidden: count(),
    })
    .from(issues)
    .innerJoin(issueRefs, eq(issues.parentId, issueRefs.id))
    .where(not(inUserAccess(db, userId, issues.repoId)))
    .groupBy(issueRefs.id)
    .all()) {
    hiddenOf.set(
      `${row.repoFullName}#${String(row.number)}`.toLowerCase(),
      row.hidden,
    );
  }

  const rootKey = issueKey(root.owner, root.repo, root.number);
  const listedKeys = new Set(
    listed.map((sub) => issueKey(sub.owner, sub.repo, sub.number)),
  );
  const visited = new Set([rootKey]);
  const descend = (item: IssueItem): SubIssueNode => {
    const key = issueKey(item.repo.owner, item.repo.name, item.number);
    visited.add(key);
    return {
      owner: item.repo.owner,
      repo: item.repo.name,
      number: item.number,
      title: item.title,
      state: "OPEN",
      url: item.url,
      synced: true,
      subIssues: item.subIssues,
      notAccessible: hiddenOf.get(key) ?? 0,
      children: (childrenOf.get(key) ?? [])
        .filter((child) => {
          const childKey = issueKey(
            child.repo.owner,
            child.repo.name,
            child.number,
          );
          return !visited.has(childKey) && !listedKeys.has(childKey);
        })
        .map(descend),
    };
  };

  return listed.map((sub) => {
    const key = issueKey(sub.owner, sub.repo, sub.number);
    const item = syncedByKey.get(key);
    if (item === undefined || key === rootKey) {
      return {
        ...sub,
        synced: false,
        subIssues: null,
        notAccessible: 0,
        children: [],
      };
    }
    return {
      ...descend(item),
      title: sub.title,
      state: sub.state,
      url: sub.url,
    };
  });
}
