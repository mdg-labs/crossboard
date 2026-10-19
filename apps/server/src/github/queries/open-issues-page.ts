import type { GithubQuery } from "../query.js";

const NESTED_ISSUE = `id number title state url repository { nameWithOwner }`;

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
        labels(first: 20) { totalCount nodes { id name color description } }
        assignees(first: 10) { totalCount nodes { login avatarUrl } }
        parent { ${NESTED_ISSUE} }
        subIssuesSummary { total completed }
        issueDependenciesSummary { totalBlockedBy totalBlocking }
        blockedBy(first: 20) { totalCount nodes { ${NESTED_ISSUE} } }
        blocking(first: 20) { totalCount nodes { ${NESTED_ISSUE} } }
      }
    }
  }
}
`,
};
