import { Hono } from "hono";
import type { GithubClient } from "../github/index.js";

export interface ApiOptions {
  version: string;
  /** Handed to the route modules that call GitHub. */
  github: GithubClient;
}

export function createApi(options: ApiOptions) {
  return new Hono().get("/health", (c) =>
    c.json({ status: "ok" as const, version: options.version }),
  );
}
