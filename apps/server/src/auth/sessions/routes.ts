import { Hono } from "hono";
import {
  clearSessionCookie,
  readSessionCookie,
  type SessionCookieOptions,
} from "./cookie.js";
import type { Db } from "../../db/index.js";
import { deleteSession } from "./store.js";

export interface AuthRoutesOptions extends SessionCookieOptions {
  db: Db;
}

/** `POST /auth/logout` (FR-6): ends the session and clears its cookie. */
export function createAuthRoutes({ db, publicUrl }: AuthRoutesOptions) {
  return new Hono().post("/logout", (c) => {
    const token = readSessionCookie(c);
    if (token !== undefined && token !== "") deleteSession(db, token);
    clearSessionCookie(c, { publicUrl });
    return c.body(null, 204);
  });
}
