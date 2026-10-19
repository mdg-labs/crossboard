import type { GithubQuery } from "../query.js";
import { issueConnectionsPage, openIssuesPage } from "./issues.js";
import { repositoryStates } from "./repository-states.js";

/** Every GraphQL document the server sends. */
export const queries = {
  issueConnectionsPage,
  openIssuesPage,
  repositoryStates,
} satisfies Record<string, GithubQuery>;
