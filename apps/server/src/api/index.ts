import { Hono } from "hono";
import type { Setup } from "../auth/setup/index.js";
import type { Db } from "../db/index.js";
import type { GithubClient } from "../github/index.js";
import type { IssueDetailsLoader } from "../issues/index.js";
import { createBoardRoutes } from "./boards.js";
import { createDetailRoutes } from "./details.js";
import { createIssueRoutes } from "./issues.js";
import { createMeRoutes } from "./me.js";
import { createSuggestRoutes } from "./suggest.js";
import { createViewRoutes } from "./views.js";

export interface ApiOptions {
  version: string;
  /** Handed to the route modules that call GitHub. */
  github: GithubClient;
  db: Db;
  setup: Setup;
  details: IssueDetailsLoader;
}

export function createApi(options: ApiOptions) {
  return new Hono()
    .get("/health", (c) =>
      c.json({ status: "ok" as const, version: options.version }),
    )
    .route("/", createMeRoutes({ db: options.db, setup: options.setup }))
    .route("/", createIssueRoutes({ db: options.db }))
    .route("/", createDetailRoutes({ details: options.details }))
    .route("/", createSuggestRoutes({ db: options.db }))
    .route("/", createViewRoutes({ db: options.db }))
    .route("/", createBoardRoutes({ db: options.db }));
}
