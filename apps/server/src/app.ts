import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Logger } from "pino";
import { createApi } from "./api/index.js";
import { createErrorHandler, notFound } from "./api/errors.js";
import type { GithubClient } from "./github/index.js";

export interface AppOptions {
  logger: Logger;
  github: GithubClient;
  version: string;
  webRoot: string;
}

export function createApp(options: AppOptions) {
  const app = new Hono().route(
    "/api",
    createApi({ version: options.version, github: options.github }),
  );

  app.all("/api/*", notFound);
  app.use(serveStatic({ root: options.webRoot }));
  const spaFallback = serveStatic({
    path: join(options.webRoot, "index.html"),
  });
  app.use((c, next) =>
    c.req.path.startsWith("/assets/") ? next() : spaFallback(c, next),
  );
  app.notFound(notFound);
  app.onError(createErrorHandler(options.logger));
  return app;
}

export type AppType = ReturnType<typeof createApp>;
