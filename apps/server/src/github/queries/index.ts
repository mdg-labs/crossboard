import type { GithubQuery } from "../query.js";
import { issueDetails } from "./issue-details.js";
import { issueConnectionsPage, issuesByIds, openIssuesPage } from "./issues.js";
import { repositoryStates } from "./repository-states.js";

/** Every GraphQL document the server sends. */
export const queries = {
  issueConnectionsPage,
  issueDetails,
  issuesByIds,
  openIssuesPage,
  repositoryStates,
} satisfies Record<string, GithubQuery>;
