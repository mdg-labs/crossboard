import type { Context, MiddlewareHandler } from "hono";
import { errorResponse } from "../../api/errors.js";
import type { Db } from "../../db/index.js";
import {
  readSessionCookie,
  setSessionCookie,
  type SessionCookieOptions,
} from "./cookie.js";
import { findSession, type Session } from "./store.js";

export interface SessionEnv {
  Variables: { session: Session };
}

export interface SessionMiddlewareOptions extends SessionCookieOptions {
  db: Db;
}

/** The session the request's cookie refers to, else null. */
function authenticate(
  c: Context,
  options: SessionMiddlewareOptions,
): Session | null {
  const token = readSessionCookie(c);
  if (token === undefined || token === "") return null;
  const found = findSession(options.db, token);
  if (found === null) return null;
  if (found.refreshed) setSessionCookie(c, options, token);
  return { userId: found.userId, tokenHash: found.tokenHash };
}

const isPublicApiPath = (path: string) =>
  path === "/api/health" || path.startsWith("/api/setup/");

/**
 * Requires a session on every `/api/*` route except the health endpoint and
 * the setup routes (SPEC §7.4), and exposes it as `c.var.session`.
 */
export function requireApiSession(
  options: SessionMiddlewareOptions,
): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    if (isPublicApiPath(c.req.path)) return next();
    const session = authenticate(c, options);
    if (session === null) {
      return errorResponse(
        c,
        401,
        "unauthorized",
        "Sign in to use this instance",
      );
    }
    c.set("session", session);
    return next();
  };
}

/**
 * Keeps only a same-origin relative path: it must start with a single `/`,
 * with no backslash or control character that a browser could read as a host.
 */
export function sanitizeReturnPath(value: string | undefined): string {
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/";
  }
  try {
    const base = "http://crossboard.invalid";
    return new URL(value, base).origin === base ? value : "/";
  } catch {
    return "/";
  }
}

const isPageExempt = (path: string) =>
  path === "/setup" ||
  path.startsWith("/setup/") ||
  path === "/auth" ||
  path.startsWith("/auth/") ||
  path.startsWith("/assets/");

/**
 * Redirects a page request without a session to `/auth/login?return=<path>`
 * (FR-10a). The setup and auth paths are exempt; so is `/assets/`, which only
 * ever holds the built bundle.
 */
export function requirePageSession(
  options: SessionMiddlewareOptions,
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if ((method !== "GET" && method !== "HEAD") || isPageExempt(c.req.path)) {
      return next();
    }
    if (authenticate(c, options) !== null) return next();
    const url = new URL(c.req.url);
    const back = sanitizeReturnPath(`${url.pathname}${url.search}`);
    return c.redirect(`/auth/login?return=${encodeURIComponent(back)}`, 302);
  };
}
