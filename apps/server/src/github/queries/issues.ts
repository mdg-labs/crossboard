import type { GithubQuery } from "../query.js";

// The selections of SPEC §5.3, shared by every document that reads issues.

/** An issue named inside another issue's relations. */
const NESTED_ISSUE = `id number title state url repository { nameWithOwner }`;
const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;
const LABEL_NODES = `nodes { id name color description }`;
const ASSIGNEE_NODES = `nodes { login avatarUrl }`;

/** One page of a repository's open issues with the SPEC §5.3 selection. */
export const openIssuesPage: GithubQuery = {
  name: "OpenIssuesPage",
  document: `
query OpenIssuesPage($owner: String!, $name: String!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id databaseId number title url createdAt updatedAt
        author { login }
        issueType { name color }
        milestone { title url }
        labels(first: 20) { totalCount ${PAGE_INFO} ${LABEL_NODES} }
        assignees(first: 10) { totalCount ${PAGE_INFO} ${ASSIGNEE_NODES} }
        parent { ${NESTED_ISSUE} }
        subIssuesSummary { total completed }
        issueDependenciesSummary { totalBlockedBy totalBlocking }
        blockedBy(first: 20) { totalCount ${PAGE_INFO} nodes { ${NESTED_ISSUE} } }
        blocking(first: 20) { totalCount ${PAGE_INFO} nodes { ${NESTED_ISSUE} } }
      }
    }
  }
}
`,
};

/**
 * The next page of the labels, assignees, `blockedBy` and `blocking` of one
 * issue, for each connection whose flag is set (SPEC §5.3: a connection whose
 * `totalCount` exceeds its first page is paged by follow-up queries).
 */
export const issueConnectionsPage: GithubQuery = {
  name: "IssueConnectionsPage",
  document: `
query IssueConnectionsPage(
  $id: ID!
  $labels: Boolean!
  $labelsAfter: String
  $assignees: Boolean!
  $assigneesAfter: String
  $blockedBy: Boolean!
  $blockedByAfter: String
  $blocking: Boolean!
  $blockingAfter: String
) {
  rateLimit { cost remaining resetAt }
  node(id: $id) {
    ... on Issue {
      labels(first: 20, after: $labelsAfter) @include(if: $labels) {
        ${PAGE_INFO} ${LABEL_NODES}
      }
      assignees(first: 10, after: $assigneesAfter) @include(if: $assignees) {
        ${PAGE_INFO} ${ASSIGNEE_NODES}
      }
      blockedBy(first: 20, after: $blockedByAfter) @include(if: $blockedBy) {
        ${PAGE_INFO} nodes { ${NESTED_ISSUE} }
      }
      blocking(first: 20, after: $blockingAfter) @include(if: $blocking) {
        ${PAGE_INFO} nodes { ${NESTED_ISSUE} }
      }
    }
  }
}
`,
};
