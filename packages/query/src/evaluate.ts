import type { IssueRef, Node, QualifierNode } from "./types.js";

export interface IssueRelation extends IssueRef {
  state: "OPEN" | "CLOSED";
}

export interface FilterableIssue {
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  authorLogin: string;
  typeName: string | null;
  milestoneTitle: string | null;
  labels: string[];
  assignees: string[];
  parent: IssueRef | null;
  subIssueTotal: number;
  blockedBy: IssueRelation[];
  blocking: IssueRelation[];
  blockedByNotAccessible: number;
  blockingNotAccessible: number;
}

export interface EvaluationContext {
  viewerLogin: string;
}

const ME = "@me";

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameIssue(a: IssueRef, b: IssueRef): boolean {
  return (
    a.number === b.number && same(a.owner, b.owner) && same(a.repo, b.repo)
  );
}

function isBlocked(issue: FilterableIssue): boolean {
  return (
    issue.blockedByNotAccessible > 0 ||
    issue.blockedBy.some((relation) => relation.state === "OPEN")
  );
}

function isBlocking(issue: FilterableIssue): boolean {
  return (
    issue.blockingNotAccessible > 0 ||
    issue.blocking.some((relation) => relation.state === "OPEN")
  );
}

function hasDependencies(issue: FilterableIssue): boolean {
  return (
    issue.blockedBy.length > 0 ||
    issue.blocking.length > 0 ||
    issue.blockedByNotAccessible > 0 ||
    issue.blockingNotAccessible > 0
  );
}

function matchesQualifier(
  node: QualifierNode,
  issue: FilterableIssue,
  context: EvaluationContext,
): boolean {
  const login = (value: string): string =>
    same(value, ME) ? context.viewerLogin : value;
  switch (node.name) {
    case "is":
      return node.values.some((value) => {
        switch (value) {
          case "open":
          case "issue":
            return true;
          case "closed":
          case "pr":
            return false;
          case "blocked":
            return isBlocked(issue);
          case "blocking":
            return isBlocking(issue);
        }
      });
    case "no":
      return node.values.some((value) => {
        switch (value) {
          case "label":
            return issue.labels.length === 0;
          case "assignee":
            return issue.assignees.length === 0;
          case "milestone":
            return issue.milestoneTitle === null;
          case "type":
            return issue.typeName === null;
          case "parent":
            return issue.parent === null;
        }
      });
    case "has":
      return node.values.some((value) => {
        switch (value) {
          case "sub-issues":
            return issue.subIssueTotal > 0;
          case "parent":
            return issue.parent !== null;
          case "dependencies":
            return hasDependencies(issue);
        }
      });
    case "label":
      return node.values.some((value) =>
        issue.labels.some((label) => same(label, value)),
      );
    case "assignee":
      return node.values.some((value) =>
        issue.assignees.some((assignee) => same(assignee, login(value))),
      );
    case "author":
      return node.values.some((value) => same(issue.authorLogin, login(value)));
    case "org":
    case "user":
      return node.values.some((value) => same(issue.repoOwner, value));
    case "repo":
      return node.values.some(
        (value) =>
          same(issue.repoOwner, value.owner) &&
          same(issue.repoName, value.name),
      );
    case "type":
      return node.values.some(
        (value) => issue.typeName !== null && same(issue.typeName, value),
      );
    case "milestone":
      return node.values.some(
        (value) =>
          issue.milestoneTitle !== null && same(issue.milestoneTitle, value),
      );
    case "parent":
      return node.values.some(
        (value) => issue.parent !== null && sameIssue(issue.parent, value),
      );
    case "blocked-by":
      return node.values.some((value) =>
        issue.blockedBy.some((relation) => sameIssue(relation, value)),
      );
    case "blocking":
      return node.values.some((value) =>
        issue.blocking.some((relation) => sameIssue(relation, value)),
      );
  }
}

export function evaluate(
  node: Node,
  issue: FilterableIssue,
  context: EvaluationContext,
): boolean {
  switch (node.type) {
    case "and":
      return node.children.every((child) => evaluate(child, issue, context));
    case "or":
      return node.children.some((child) => evaluate(child, issue, context));
    case "text":
      return issue.title.toLowerCase().includes(node.value.toLowerCase());
    case "number":
      return issue.number === node.number;
    case "ignored":
      return true;
    case "qualifier":
      return matchesQualifier(node, issue, context) !== node.negated;
  }
}
