import type { GithubQuery } from "../query.js";

/**
 * The lazily fetched fields of one issue (SPEC §5.3, FR-42, FR-43): the
 * rendered body, the most recent 100 comments and the first 50 sub-issues.
 */
export const issueDetails: GithubQuery = {
  name: "IssueDetails",
  document: `
query IssueDetails($id: ID!) {
  rateLimit { cost remaining limit resetAt }
  node(id: $id) {
    ... on Issue {
      bodyHTML
      comments(last: 100) {
        totalCount
        nodes {
          url
          createdAt
          author { login avatarUrl }
          bodyHTML
        }
      }
      subIssues(first: 50) {
        totalCount
        nodes { id number title state url repository { nameWithOwner } }
      }
    }
  }
}
`,
};
