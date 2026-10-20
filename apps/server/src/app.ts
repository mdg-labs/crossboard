import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Logger } from "pino";
import { activeInstallationIds, type Access } from "./access/index.js";
import { createApi } from "./api/index.js";
import { createErrorHandler, notFound } from "./api/errors.js";
import {
  createSetupCallback,
  createSetupRoutes,
  setupGate,
  type Setup,
} from "./auth/setup/index.js";
import { createSignInRoutes } from "./auth/sign-in/index.js";
import {
  createAuthRoutes,
  requireApiSession,
  requirePageSession,
} from "./auth/sessions/index.js";
import type { Db } from "./db/index.js";
import type { GithubClient, InstallationClient } from "./github/index.js";
import { createIssueDetails } from "./issues/index.js";
import type { Jobs } from "./jobs/index.js";
import {
  contentSecurityPolicy,
  protectStateChanges,
} from "./security/index.js";
import {
  createWebhookRoutes,
  WEBHOOK_PATH,
  type WebhookHandler,
} from "./webhooks/index.js";

export interface AppOptions {
  logger: Logger;
  db: Db;
  github: GithubClient;
  version: string;
  webRoot: string;
  setup: Setup;
  access: Access;
  appSecret: string;
  publicUrl: string;
  /** What the routes that read GitHub data call as an installation. */
  installations: Pick<InstallationClient, "budgets" | "graphql">;
  /** Runs the webhook deliveries the intake accepts. */
  jobs: Jobs;
  /** The event handlers of `createWebhookHandlers`; without them every delivery is acknowledged and dropped. */
  webhookHandlers?: Readonly<Record<string, WebhookHandler>>;
}

export function createApp(options: AppOptions) {
  const sessionOptions = { db: options.db, publicUrl: options.publicUrl };
  const details = createIssueDetails({
    db: options.db,
    installations: options.installations,
    isActive: (installationId) =>
      activeInstallationIds(options.db, options.setup.allowlist).has(
        installationId,
      ),
    logger: options.logger,
  });
  const app = new Hono()
    .use(contentSecurityPolicy())
    .use(setupGate(options.setup, options.webRoot))
    .use(protectStateChanges(options.publicUrl))
    .use("/api/*", requireApiSession(sessionOptions))
    .route(
      "/api/setup",
      createSetupRoutes({
        setup: options.setup,
        appSecret: options.appSecret,
        publicUrl: options.publicUrl,
      }),
    )
    .route(
      "/setup/callback",
      createSetupCallback({
        setup: options.setup,
        github: options.github,
        logger: options.logger,
        appSecret: options.appSecret,
      }),
    )
    .route("/auth", createAuthRoutes(sessionOptions))
    .route(
      "/auth",
      createSignInRoutes({
        ...sessionOptions,
        github: options.github,
        setup: options.setup,
        logger: options.logger,
        appSecret: options.appSecret,
        access: options.access,
      }),
    )
    .route(
      WEBHOOK_PATH,
      createWebhookRoutes({
        db: options.db,
        jobs: options.jobs,
        logger: options.logger,
        allowlist: options.setup.allowlist,
        webhookSecret: () => options.setup.credentials()?.webhookSecret ?? null,
        handlers: options.webhookHandlers ?? {},
      }),
    )
    .route(
      "/api",
      createApi({
        version: options.version,
        github: options.github,
        db: options.db,
        setup: options.setup,
        details,
        budgets: options.installations.budgets,
        jobs: options.jobs,
      }),
    );

  app.all("/api/*", notFound);
  // Without a built web app serveStatic is not mounted, since it logs a
  // warning for the missing root each time it is created; the requests fall
  // through to the error-shape 404 below.
  const hasWebApp = existsSync(join(options.webRoot, "index.html"));
  if (hasWebApp) {
    // Directory requests and /index.html would serve the shell without the
    // session check below.
    const staticFiles = serveStatic({ root: options.webRoot });
    app.use((c, next) =>
      c.req.path.endsWith("/") || c.req.path === "/index.html"
        ? next()
        : staticFiles(c, next),
    );
  }
  app.use(requirePageSession(sessionOptions));
  if (hasWebApp) {
    const spaFallback = serveStatic({
      path: join(options.webRoot, "index.html"),
    });
    app.use((c, next) =>
      c.req.path.startsWith("/assets/") ? next() : spaFallback(c, next),
    );
  }
  app.notFound(notFound);
  app.onError(createErrorHandler(options.logger));
  return app;
}

export type AppType = ReturnType<typeof createApp>;
