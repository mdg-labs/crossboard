import { Hono } from "hono";
import type { Setup } from "../auth/setup/index.js";
import type { Db } from "../db/index.js";
import type { GithubClient } from "../github/index.js";
import { createMeRoutes } from "./me.js";

export interface ApiOptions {
  version: string;
  /** Handed to the route modules that call GitHub. */
  github: GithubClient;
  db: Db;
  setup: Setup;
}

export function createApi(options: ApiOptions) {
  return new Hono()
    .get("/health", (c) =>
      c.json({ status: "ok" as const, version: options.version }),
    )
    .route("/", createMeRoutes({ db: options.db, setup: options.setup }));
}
