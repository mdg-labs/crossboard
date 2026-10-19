import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type AppOptions } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import type { TestDatabase } from "./database.js";
import {
  githubEnv,
  validEnv,
  unusedInstallations,
  unusedJobs,
} from "./helpers.js";
import { createTestAccess } from "./sign-in.js";

/** The origin the CSRF guard of SPEC §9.3 accepts on a state-changing request. */
export const ORIGIN = validEnv.CROSSBOARD_PUBLIC_URL;

/** The headers a state-changing `/api` request carries to pass that guard. */
export const jsonHeaders = (cookie: string) => ({
  Cookie: cookie,
  Origin: ORIGIN,
  "Content-Type": "application/json",
});

/** A fully wired app over the test database, with a stub SPA bundle in `dir`. */
export function buildApiApp(
  database: TestDatabase,
  dir: string,
  overrides: Partial<Pick<AppOptions, "installations" | "jobs">> = {},
) {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
  const logger = createLogger("silent");
  const config = loadConfig({
    ...validEnv,
    ...githubEnv,
    CROSSBOARD_ALLOWED_USERS: "octocat",
  });
  const github = createGithubClient({
    apiUrl: config.githubApiUrl,
    webUrl: config.githubWebUrl,
    logger,
  });
  const setup = createSetup({ db: database.db, config, logger });
  return createApp({
    logger,
    db: database.db,
    github,
    installations: unusedInstallations,
    jobs: unusedJobs,
    ...overrides,
    version: "1.0.0",
    webRoot: join(dir, "dist"),
    setup,
    access: createTestAccess({
      db: database.db,
      github,
      setup,
      appSecret: config.appSecret,
      logger,
    }),
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
  });
}

let nextRepo = 1000;

/** An installation row that every repo seeded by `addRepo` belongs to. */
export function addInstallation(database: TestDatabase, id = 1) {
  database.db
    .insert(schema.installations)
    .values({
      id,
      accountLogin: `account${String(id)}`,
      accountId: id,
      accountType: "Organization",
      suspended: false,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

/** A repo of installation 1, readable by exactly `userIds`. */
export function addRepo(
  database: TestDatabase,
  owner: string,
  name: string,
  userIds: number[],
): string {
  const id = `R_${String(nextRepo)}`;
  database.db
    .insert(schema.repos)
    .values({
      id,
      databaseId: nextRepo++,
      installationId: 1,
      owner,
      name,
      private: true,
      syncState: "ready",
      openIssueCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  for (const userId of userIds) {
    database.db
      .insert(schema.userRepoAccess)
      .values({ userId, repoId: id, computedAt: 1 })
      .run();
  }
  return id;
}
