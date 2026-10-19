import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  activeInstallationIds,
  createAccess,
  purgeInactiveInstallations,
  registerAccessJob,
} from "./access/index.js";
import { createApp } from "./app.js";
import {
  enqueueSessionCleanupAtStart,
  registerSessionCleanup,
} from "./auth/sessions/index.js";
import { createSetup } from "./auth/setup/index.js";
import { createUserTokens } from "./auth/tokens.js";
import { ConfigError, loadConfig, type Config } from "./config/index.js";
import { openAndMigrate, type DatabaseHandle } from "./db/index.js";
import {
  createGithubClient,
  createInstallationClient,
} from "./github/index.js";
import { createInstallationPause, createJobs } from "./jobs/index.js";
import { createLogger } from "./logger.js";
import {
  createDiscovery,
  enqueueDiscovery,
  registerDiscoveryJob,
  registerDiscoverySchedule,
} from "./sync/discovery.js";
import { createReconcile, registerReconcileJobs } from "./sync/reconcile.js";
import { createRefetch } from "./sync/refetch.js";
import { registerResyncJob } from "./sync/resync.js";
import {
  createSync,
  enqueueSync,
  enqueueSyncAtStart,
  registerSyncJob,
} from "./sync/sync.js";
import { readServerVersion } from "./version.js";
import { createWebhookHandlers, webhookJobName } from "./webhooks/index.js";
import type { Logger } from "pino";

function bootstrap(): {
  config: Config;
  logger: Logger;
  database: DatabaseHandle;
} {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    const logger = createLogger();
    if (error instanceof ConfigError) {
      logger.fatal({ issues: error.issues }, error.message);
    } else {
      logger.fatal({ err: error }, "failed to load the configuration");
    }
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  try {
    const database = openAndMigrate(config.dataDir);
    logger.info({ path: database.path }, "database ready");
    return { config, logger, database };
  } catch (error) {
    logger.fatal(
      { err: error },
      "failed to open the database and apply migrations",
    );
    process.exit(1);
  }
}

export const { config, logger, database } = bootstrap();

logger.info(
  { port: config.port, webhooks: config.webhooks },
  "crossboard configured",
);

export const github = createGithubClient({
  apiUrl: config.githubApiUrl,
  webUrl: config.githubWebUrl,
  logger,
});

// Started once the migrations are applied, so handlers can rely on the schema.
// Every background job that names an installation passes the pause rule: a
// suspended installation's job is dropped and one below 10% of its budget
// waits for the reset. The deliveries that lift a suspension or remove the
// installation are exempt, or a suspended installation could never resume.
export const jobs = createJobs({
  logger,
  pause: createInstallationPause({
    db: database.db,
    budgets: github.budgets,
    exemptJobs: [
      "installation",
      "installation_repositories",
      "github_app_authorization",
    ].map(webhookJobName),
  }),
});
registerSessionCleanup(jobs, database.db, logger);
jobs.start();
enqueueSessionCleanupAtStart(jobs);

const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (!existsSync(join(webRoot, "index.html"))) {
  logger.warn(
    { webRoot },
    "the built web app was not found; only /api is served",
  );
}

export const setup = createSetup({ db: database.db, config, logger });
try {
  setup.start();
} catch (error) {
  logger.fatal({ err: error }, "failed to write the setup token file");
  process.exit(1);
}

// The one installation client of the process, with one installation-token
// cache: the sync jobs and the routes that read GitHub data fetch through it.
export const installations = createInstallationClient({
  github,
  credentials: () => setup.credentials(),
});

const isActive = (installationId: number) =>
  activeInstallationIds(database.db, setup.allowlist).has(installationId);

// Refetches issues by node id and removes them by the SPEC §8.2 rules; the
// sync uses it for the issues a full sync no longer returns.
export const issues = createRefetch({
  db: database.db,
  installations,
  isActive,
  logger,
});

export const sync = createSync({
  db: database.db,
  installations,
  isActive,
  refetch: (ids) => issues.refetch(ids),
  logger,
});
registerSyncJob(jobs, sync);
registerResyncJob(jobs, database.db, setup.allowlist);

// Polls every ready repo for the issues updated since its last round, the
// safety net under the webhooks and the only source without them (SPEC §6.3).
export const reconcile = createReconcile({
  db: database.db,
  installations,
  isActive,
  issues,
  logger,
});
registerReconcileJobs(
  jobs,
  reconcile,
  database.db,
  isActive,
  config.reconcileIntervalMin * 60_000,
);

export const discovery = createDiscovery({
  db: database.db,
  installations,
  isActive,
  logger,
  onPending: (pending) => {
    for (const repo of pending) enqueueSync(jobs, repo);
  },
});
registerDiscoveryJob(jobs, discovery, logger);
registerDiscoverySchedule(jobs, database.db, isActive);

export const access = createAccess({
  db: database.db,
  github,
  allowlist: setup.allowlist,
  logger,
  tokens: createUserTokens({
    db: database.db,
    github,
    credentials: () => setup.credentials(),
    appSecret: config.appSecret,
    logger,
  }),
  onActivated: (installationIds) => {
    for (const id of installationIds) enqueueDiscovery(jobs, id);
  },
});
registerAccessJob(jobs, access, database.db, logger);

// An allowlist change since the last run can leave installations inactive that
// no access computation saw go; their repos are purged before anything is
// discovered or synced.
purgeInactiveInstallations(database.db, setup.allowlist, logger);

// Every active installation is discovered again at startup, then the repos a
// restart left `pending` or `syncing` are synced.
for (const id of activeInstallationIds(database.db, setup.allowlist)) {
  enqueueDiscovery(jobs, id);
}
enqueueSyncAtStart(jobs, database.db, setup.allowlist);

const webhookHandlers = createWebhookHandlers({
  db: database.db,
  jobs,
  issues,
  access,
  allowlist: setup.allowlist,
});

const app = createApp({
  logger,
  db: database.db,
  github,
  installations,
  jobs,
  webhookHandlers,
  version: readServerVersion(),
  webRoot,
  setup,
  access,
  appSecret: config.appSecret,
  publicUrl: config.publicUrl,
});

// Without the http2 option, serve() returns a plain http.Server.
export const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "listening");
}) as Server;

server.on("error", (error) => {
  logger.fatal({ err: error, port: config.port }, "the HTTP server failed");
  process.exit(1);
});

// The container runs this process as PID 1, where an unhandled SIGTERM is
// ignored and `docker stop` ends in a SIGKILL. Stop accepting connections, let
// in-flight requests and running jobs finish (cut off after a grace period
// shorter than Docker's 10 s), then close the database so the WAL is
// checkpointed.
const SHUTDOWN_GRACE_MS = 5_000;

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down");
  const jobsStopped = jobs.stop();
  // One deadline from the start of the shutdown bounds both the connection
  // drain and the job wait; it is not unref'd, so it keeps the process alive
  // until the database is closed.
  const grace = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_GRACE_MS);
  });
  server.close(() => {
    void Promise.race([jobsStopped, grace]).then(() => {
      database.sqlite.close();
      process.exit(0);
    });
  });
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, shutdown);
}
