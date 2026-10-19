import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "../../db/index.js";
import { createSession, SESSION_TTL_MS } from "./store.js";

export const SESSION_COOKIE = "crossboard_session";

export interface SessionCookieOptions {
  publicUrl: string;
}

export const isLocalHttp = (publicUrl: string) => {
  const url = new URL(publicUrl);
  return url.protocol === "http:" && url.hostname === "localhost";
};

const attributes = ({ publicUrl }: SessionCookieOptions) =>
  ({
    httpOnly: true,
    sameSite: "Lax",
    secure: !isLocalHttp(publicUrl),
    path: "/",
  }) as const;

export function setSessionCookie(
  c: Context,
  options: SessionCookieOptions,
  token: string,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    ...attributes(options),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(
  c: Context,
  options: SessionCookieOptions,
): void {
  deleteCookie(c, SESSION_COOKIE, attributes(options));
}

export const readSessionCookie = (c: Context): string | undefined =>
  getCookie(c, SESSION_COOKIE);

/** Creates a session for the user and sets its cookie on the response. */
export function issueSession(
  c: Context,
  options: SessionCookieOptions & { db: Db },
  userId: number,
  now: number = Date.now(),
): void {
  setSessionCookie(c, options, createSession(options.db, userId, now));
}
