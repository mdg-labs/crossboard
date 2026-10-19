import type { Logger } from "pino";
import { createAccess, type Access } from "../src/access/index.js";
import type { Setup } from "../src/auth/setup/index.js";
import { createUserTokens } from "../src/auth/tokens.js";
import type { GithubClient } from "../src/github/index.js";
import { SESSION_COOKIE, createSession } from "../src/auth/sessions/index.js";
import { schema, type Db } from "../src/db/index.js";

let nextGithubId = 1000;

export function addUser(db: Db, login = `user${String(nextGithubId)}`) {
  const user = db
    .insert(schema.users)
    .values({
      githubId: nextGithubId++,
      login,
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
      createdAt: 1,
      lastLoginAt: 1,
    })
    .returning()
    .get();
  return user;
}

/** A user with a live session, and the Cookie header that carries it. */
export function signIn(db: Db, userId: number = addUser(db).id, now?: number) {
  const token = createSession(db, userId, now);
  return { userId, token, cookie: `${SESSION_COOKIE}=${token}` };
}

/** The access instance `index.ts` builds: one user-token store behind it. */
export function createTestAccess(options: {
  db: Db;
  github: GithubClient;
  setup: Setup;
  appSecret: string;
  logger: Logger;
}): Access {
  const { db, github, setup, appSecret, logger } = options;
  return createAccess({
    db,
    github,
    allowlist: setup.allowlist,
    logger,
    tokens: createUserTokens({
      db,
      github,
      credentials: () => setup.credentials(),
      appSecret,
      logger,
    }),
  });
}
