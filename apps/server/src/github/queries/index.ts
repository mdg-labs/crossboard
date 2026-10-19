import type { GithubQuery } from "../query.js";
import { issueConnectionsPage, issuesByIds, openIssuesPage } from "./issues.js";
import { repositoryStates } from "./repository-states.js";

/** Every GraphQL document the server sends. */
export const queries = {
  issueConnectionsPage,
  issuesByIds,
  openIssuesPage,
  repositoryStates,
} satisfies Record<string, GithubQuery>;
