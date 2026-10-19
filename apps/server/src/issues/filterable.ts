import {
  evaluate,
  parse,
  type FilterableIssue,
  type IssueRelation,
} from "@crossboard/query";
import { and, asc, eq, sql } from "drizzle-orm";
import { inUserAccess } from "../access/index.js";
import type { IssueItem } from "../api/schemas.js";
import { schema, type Db } from "../db/index.js";

const {
  issueAssignees,
  issueDeps,
  issueLabels,
  issueRefs,
  issues,
  labels,
  repos,
} = schema;

/** An issue of the viewer's access, as the list shows it and the filter sees it. */
export interface AccessibleIssue {
  item: IssueItem;
  filterable: FilterableIssue;
}

/** One issue by its place on GitHub; owner and repo match case-insensitively. */
export interface IssueLocator {
  owner: string;
  repo: string;
  number: number;
}

const GHOST = "ghost";

const isBlockedQuery = parse("is:blocked");

/**
 * `is:blocked` is answered by the query package, so the item's flag cannot
 * drift from what the filter matches (SPEC FR-25).
 */
function computeIsBlocked(issue: FilterableIssue): boolean {
  return (
    "ast" in isBlockedQuery &&
    evaluate(isBlockedQuery.ast, issue, { viewerLogin: "" })
  );
}

const splitFullName = (fullName: string) => {
  const slash = fullName.indexOf("/");
  return {
    owner: fullName.slice(0, slash),
    repo: fullName.slice(slash + 1),
  };
};

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Loads every issue in the user's repo access (SPEC FR-9) with its labels,
 * assignees and dependency states, and maps each to the issue item and to the
 * `FilterableIssue` that `packages/query` evaluates. Issues are stored open
 * only, so every row here is open.
 *
 * A parent or a dependency in a repo outside the user's access is never named:
 * the parent is dropped and the relation counts as not accessible for this
 * user, so another user's private repo cannot show through an edge (SPEC §9.1).
 *
 * With `only`, loads just that issue, and nothing when it is not synced or
 * not in the user's access.
 */
export function loadAccessibleIssues(
  db: Db,
  userId: number,
  only?: IssueLocator,
): AccessibleIssue[] {
  let scope = inUserAccess(db, userId, issues.repoId);
  if (only !== undefined) {
    const target = db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(repos, eq(issues.repoId, repos.id))
      .where(
        and(
          scope,
          sql`lower(${repos.owner}) = ${only.owner.toLowerCase()}`,
          sql`lower(${repos.name}) = ${only.repo.toLowerCase()}`,
          eq(issues.number, only.number),
        ),
      )
      .get();
    if (target === undefined) return [];
    scope = and(scope, eq(issues.id, target.id)) ?? scope;
  }

  const rows = db
    .select({
      id: issues.id,
      repoOwner: repos.owner,
      repoName: repos.name,
      number: issues.number,
      title: issues.title,
      url: issues.url,
      authorLogin: issues.authorLogin,
      typeName: issues.typeName,
      typeColor: issues.typeColor,
      milestoneTitle: issues.milestoneTitle,
      milestoneUrl: issues.milestoneUrl,
      parentRepo: issueRefs.repoFullName,
      parentNumber: issueRefs.number,
      subTotal: issues.subTotal,
      subCompleted: issues.subCompleted,
      blockedByTotal: issues.blockedByTotal,
      blockingTotal: issues.blockingTotal,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .leftJoin(issueRefs, eq(issues.parentId, issueRefs.id))
    .where(scope)
    .all();

  const accessibleRepos = new Set(
    db
      .select({ owner: repos.owner, name: repos.name })
      .from(repos)
      .where(inUserAccess(db, userId, repos.id))
      .all()
      .map((repo) => `${repo.owner}/${repo.name}`.toLowerCase()),
  );

  const labelsOf = new Map<string, { name: string; color: string }[]>();
  for (const row of db
    .select({
      issueId: issueLabels.issueId,
      name: labels.name,
      color: labels.color,
    })
    .from(issueLabels)
    .innerJoin(issues, eq(issueLabels.issueId, issues.id))
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(scope)
    .orderBy(asc(labels.name))
    .all()) {
    append(labelsOf, row.issueId, { name: row.name, color: row.color });
  }

  const assigneesOf = new Map<string, { login: string; avatarUrl: string }[]>();
  for (const row of db
    .select({
      issueId: issueAssignees.issueId,
      login: issueAssignees.login,
      avatarUrl: issueAssignees.avatarUrl,
    })
    .from(issueAssignees)
    .innerJoin(issues, eq(issueAssignees.issueId, issues.id))
    .where(scope)
    .orderBy(asc(issueAssignees.login))
    .all()) {
    append(assigneesOf, row.issueId, {
      login: row.login,
      avatarUrl: row.avatarUrl,
    });
  }

  const blockedByOf = new Map<string, IssueRelation[]>();
  const blockingOf = new Map<string, IssueRelation[]>();
  const relation = (ref: {
    repoFullName: string;
    number: number;
    state: "OPEN" | "CLOSED";
  }): IssueRelation | null =>
    accessibleRepos.has(ref.repoFullName.toLowerCase())
      ? {
          ...splitFullName(ref.repoFullName),
          number: ref.number,
          state: ref.state,
        }
      : null;
  for (const row of db
    .select({
      issueId: issueDeps.blockedId,
      repoFullName: issueRefs.repoFullName,
      number: issueRefs.number,
      state: issueRefs.state,
    })
    .from(issueDeps)
    .innerJoin(issues, eq(issueDeps.blockedId, issues.id))
    .innerJoin(issueRefs, eq(issueDeps.blockingId, issueRefs.id))
    .where(scope)
    .orderBy(asc(issueRefs.repoFullName), asc(issueRefs.number))
    .all()) {
    const found = relation(row);
    if (found !== null) append(blockedByOf, row.issueId, found);
  }
  for (const row of db
    .select({
      issueId: issueDeps.blockingId,
      repoFullName: issueRefs.repoFullName,
      number: issueRefs.number,
      state: issueRefs.state,
    })
    .from(issueDeps)
    .innerJoin(issues, eq(issueDeps.blockingId, issues.id))
    .innerJoin(issueRefs, eq(issueDeps.blockedId, issueRefs.id))
    .where(scope)
    .orderBy(asc(issueRefs.repoFullName), asc(issueRefs.number))
    .all()) {
    const found = relation(row);
    if (found !== null) append(blockingOf, row.issueId, found);
  }

  return rows.map((row) => {
    const issueLabelList = labelsOf.get(row.id) ?? [];
    const assigneeList = assigneesOf.get(row.id) ?? [];
    const blockedBy = blockedByOf.get(row.id) ?? [];
    const blocking = blockingOf.get(row.id) ?? [];
    const parent =
      row.parentRepo !== null &&
      row.parentNumber !== null &&
      accessibleRepos.has(row.parentRepo.toLowerCase())
        ? { ...splitFullName(row.parentRepo), number: row.parentNumber }
        : null;
    const author = row.authorLogin ?? GHOST;
    const blockedByNotAccessible = Math.max(
      0,
      row.blockedByTotal - blockedBy.length,
    );
    const blockingNotAccessible = Math.max(
      0,
      row.blockingTotal - blocking.length,
    );

    const filterable: FilterableIssue = {
      repoOwner: row.repoOwner,
      repoName: row.repoName,
      number: row.number,
      title: row.title,
      authorLogin: author,
      typeName: row.typeName,
      milestoneTitle: row.milestoneTitle,
      labels: issueLabelList.map((label) => label.name),
      assignees: assigneeList.map((assignee) => assignee.login),
      parent,
      subIssueTotal: row.subTotal,
      blockedBy,
      blocking,
      blockedByNotAccessible,
      blockingNotAccessible,
    };
    const item: IssueItem = {
      id: row.id,
      repo: { owner: row.repoOwner, name: row.repoName },
      number: row.number,
      title: row.title,
      url: row.url,
      author,
      type:
        row.typeName === null
          ? null
          : { name: row.typeName, color: row.typeColor },
      milestone:
        row.milestoneTitle === null || row.milestoneUrl === null
          ? null
          : { title: row.milestoneTitle, url: row.milestoneUrl },
      labels: issueLabelList,
      assignees: assigneeList,
      parent,
      subIssues: { total: row.subTotal, completed: row.subCompleted },
      blockedBy: {
        open: blockedBy.filter((entry) => entry.state === "OPEN").length,
        notAccessible: blockedByNotAccessible,
      },
      blocking: {
        open: blocking.filter((entry) => entry.state === "OPEN").length,
        notAccessible: blockingNotAccessible,
      },
      isBlocked: computeIsBlocked(filterable),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return { item, filterable };
  });
}
