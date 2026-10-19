import type { GithubQuery } from "../query.js";

/**
 * Whether each of up to 25 repositories (by node id) is archived, has issues
 * enabled, and how many open issues it has (SPEC §5.3). A node that cannot be
 * read comes back as `null`.
 */
export const repositoryStates: GithubQuery = {
  name: "RepositoryStates",
  document: `
query RepositoryStates($ids: [ID!]!) {
  rateLimit { cost remaining resetAt }
  nodes(ids: $ids) {
    ... on Repository {
      id isArchived hasIssuesEnabled
      issues(states: OPEN) { totalCount }
    }
  }
}
`,
};
