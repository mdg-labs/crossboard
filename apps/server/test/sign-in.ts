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
