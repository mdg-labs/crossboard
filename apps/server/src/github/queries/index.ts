import type { GithubQuery } from "../query.js";
import { openIssuesPage } from "./open-issues-page.js";

/** Every GraphQL document the server sends. */
export const queries = { openIssuesPage } satisfies Record<string, GithubQuery>;
