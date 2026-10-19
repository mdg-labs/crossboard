import type { GithubQuery } from "../query.js";
import { openIssuesPage } from "./open-issues-page.js";
import { repositoryStates } from "./repository-states.js";

/** Every GraphQL document the server sends. */
export const queries = { openIssuesPage, repositoryStates } satisfies Record<
  string,
  GithubQuery
>;
