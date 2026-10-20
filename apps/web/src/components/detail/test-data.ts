import type {
  IssueDetails,
  IssueRelation,
  IssueSummary,
  SubIssueNode,
} from "@/lib/issue-detail";

const NOW = Date.now();

export function summary(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    id: "issue-1",
    repo: { owner: "acme", name: "widgets" },
    number: 1,
    title: "Widget fails to render",
    url: "https://github.com/acme/widgets/issues/1",
    author: "octocat",
    type: null,
    milestone: null,
    labels: [],
    assignees: [],
    parent: null,
    subIssues: { total: 0, completed: 0 },
    ancestors: [],
    blockedBy: { open: 0, notAccessible: 0, items: [] },
    blocking: { open: 0, notAccessible: 0, items: [] },
    isBlocked: false,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3 * 3_600_000,
    ...overrides,
  };
}

export function relation(
  n: number,
  overrides: Partial<IssueRelation> = {},
): IssueRelation {
  return {
    owner: "acme",
    repo: "widgets",
    number: n,
    title: `Related issue ${n}`,
    state: "OPEN",
    url: `https://github.com/acme/widgets/issues/${n}`,
    synced: true,
    ...overrides,
  };
}

export function subIssue(
  n: number,
  overrides: Partial<SubIssueNode> = {},
): SubIssueNode {
  return {
    owner: "acme",
    repo: "widgets",
    number: n,
    title: `Sub-issue ${n}`,
    state: "OPEN",
    url: `https://github.com/acme/widgets/issues/${n}`,
    synced: true,
    subIssues: null,
    notAccessible: 0,
    children: [],
    ...overrides,
  };
}

export function details(overrides: Partial<IssueDetails> = {}): IssueDetails {
  return {
    bodyHtml: "<p>The widget <strong>fails</strong> to render.</p>",
    comments: [],
    commentsTotal: 0,
    subIssues: { total: 0, notAccessible: 0, items: [] },
    fetchedAt: NOW,
    stale: false,
    ...overrides,
  };
}
