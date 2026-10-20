import { and, count, eq, not, or, sql, type SQL } from "drizzle-orm";
import { inUserAccess } from "../access/index.js";
import type {
  IssueItem,
  IssueRelationEntry,
  SubIssue,
  SubIssueNode,
} from "../api/schemas.js";
import { schema, type Db } from "../db/index.js";
import { loadAccessibleIssues } from "./filterable.js";

const { issueRefs, issues, repos } = schema;

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

/** The columns of an issue the sub-issue tree emits. */
interface TreeIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  subIssues: IssueItem["subIssues"];
}

const treeColumns = {
  owner: repos.owner,
  repo: repos.name,
  number: issues.number,
  title: issues.title,
  url: issues.url,
  subTotal: issues.subTotal,
  subCompleted: issues.subCompleted,
};

const toTreeIssue = (row: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  subTotal: number;
  subCompleted: number;
}): TreeIssue => ({
  owner: row.owner,
  repo: row.repo,
  number: row.number,
  title: row.title,
  url: row.url,
  subIssues: { total: row.subTotal, completed: row.subCompleted },
});

const treeKey = (issue: TreeIssue) =>
  issueKey(issue.owner, issue.repo, issue.number);

/**
 * SQLite caps an expression tree at a depth of 1000, and an OR chain is one
 * level per term, so a level of the tree is looked up in batches of parents.
 */
const parentBatchSize = 200;

const never = sql`0 = 1`;
const allOf = (...conditions: SQL[]): SQL => and(...conditions) ?? never;
const anyOf = (conditions: SQL[]): SQL => or(...conditions) ?? never;

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Repo then number, the `repo-asc` order of the list (SPEC FR-13). */
const byRepoAndNumber = (a: TreeIssue, b: TreeIssue) =>
  compareText(a.owner.toLowerCase(), b.owner.toLowerCase()) ||
  compareText(a.repo.toLowerCase(), b.repo.toLowerCase()) ||
  a.number - b.number;

/**
 * Turns the first sub-issues GitHub listed for an issue into the tree of
 * SPEC FR-40. A listed sub-issue that is synced in the viewer's access gets
 * its progress and, from the parent of each synced issue, its synced
 * sub-issues, recursively and without a depth limit. Nothing here asks
 * GitHub, and it reads only the listed sub-issues and, level by level, the
 * children of the issues it reaches, every query under the viewer's access
 * (SPEC §9.1). Synced sub-issues outside the viewer's access are counted in
 * their parent's `notAccessible` and never named, and an issue that already
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

  const rootKey = issueKey(root.owner, root.repo, root.number);
  const listedKeys = new Set(
    listed.map((sub) => issueKey(sub.owner, sub.repo, sub.number)),
  );

  const syncedByKey = new Map<string, TreeIssue>();
  const listedLookup = [...listedKeys].filter((key) => key !== rootKey);
  if (listedLookup.length > 0) {
    const wanted = new Set(listedLookup);
    for (const row of db
      .select(treeColumns)
      .from(issues)
      .innerJoin(repos, eq(issues.repoId, repos.id))
      .where(
        allOf(
          inUserAccess(db, userId, issues.repoId),
          anyOf(
            listed.map((sub) =>
              allOf(
                sql`lower(${repos.owner}) = ${sub.owner.toLowerCase()}`,
                sql`lower(${repos.name}) = ${sub.repo.toLowerCase()}`,
                eq(issues.number, sub.number),
              ),
            ),
          ),
        ),
      )
      .all()) {
      const issue = toTreeIssue(row);
      if (wanted.has(treeKey(issue))) syncedByKey.set(treeKey(issue), issue);
    }
  }

  const childrenOf = new Map<string, TreeIssue[]>();
  const hiddenOf = new Map<string, number>();
  const loaded = new Set([rootKey, ...syncedByKey.keys()]);
  let frontier = [...syncedByKey.values()];
  while (frontier.length > 0) {
    const next: TreeIssue[] = [];
    for (let at = 0; at < frontier.length; at += parentBatchSize) {
      const parentMatches = anyOf(
        frontier
          .slice(at, at + parentBatchSize)
          .map((parent) =>
            allOf(
              sql`lower(${issueRefs.repoFullName}) = ${`${parent.owner}/${parent.repo}`.toLowerCase()}`,
              eq(issueRefs.number, parent.number),
            ),
          ),
      );

      for (const row of db
        .select({
          repoFullName: issueRefs.repoFullName,
          number: issueRefs.number,
          hidden: count(),
        })
        .from(issues)
        .innerJoin(issueRefs, eq(issues.parentId, issueRefs.id))
        .where(
          allOf(not(inUserAccess(db, userId, issues.repoId)), parentMatches),
        )
        .groupBy(issueRefs.id)
        .all()) {
        hiddenOf.set(
          `${row.repoFullName}#${String(row.number)}`.toLowerCase(),
          row.hidden,
        );
      }

      for (const row of db
        .select({
          ...treeColumns,
          parentRepo: issueRefs.repoFullName,
          parentNumber: issueRefs.number,
        })
        .from(issues)
        .innerJoin(repos, eq(issues.repoId, repos.id))
        .innerJoin(issueRefs, eq(issues.parentId, issueRefs.id))
        .where(allOf(inUserAccess(db, userId, issues.repoId), parentMatches))
        .all()) {
        const child = toTreeIssue(row);
        const parentKey =
          `${row.parentRepo}#${String(row.parentNumber)}`.toLowerCase();
        const siblings = childrenOf.get(parentKey);
        if (siblings === undefined) childrenOf.set(parentKey, [child]);
        else siblings.push(child);
        const childKey = treeKey(child);
        if (!loaded.has(childKey)) {
          loaded.add(childKey);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  for (const siblings of childrenOf.values()) siblings.sort(byRepoAndNumber);

  const visited = new Set([rootKey]);
  const descend = (item: TreeIssue): SubIssueNode => {
    const key = treeKey(item);
    visited.add(key);
    return {
      owner: item.owner,
      repo: item.repo,
      number: item.number,
      title: item.title,
      state: "OPEN",
      url: item.url,
      synced: true,
      subIssues: item.subIssues,
      notAccessible: hiddenOf.get(key) ?? 0,
      children: (childrenOf.get(key) ?? [])
        .filter((child) => {
          const childKey = treeKey(child);
          return !visited.has(childKey) && !listedKeys.has(childKey);
        })
        .map(descend),
    };
  };

  return listed.map((sub) => {
    const key = issueKey(sub.owner, sub.repo, sub.number);
    const item = syncedByKey.get(key);
    if (item === undefined) {
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
