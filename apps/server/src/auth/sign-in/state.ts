import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { isLocalHttp, type SessionCookieOptions } from "../sessions/index.js";

export const OAUTH_STATE_COOKIE = "crossboard_oauth";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const attributes = ({ publicUrl }: SessionCookieOptions) =>
  ({
    httpOnly: true,
    sameSite: "Lax",
    secure: !isLocalHttp(publicUrl),
    path: "/auth",
  }) as const;

/**
 * Starts a sign-in: sets the cookie that holds the OAuth `state` and the path
 * to return to, and returns the state to send to GitHub (SPEC FR-4). The
 * cookie is `SameSite=Lax`, so it comes back on GitHub's redirect.
 */
export function issueOAuthState(
  c: Context,
  options: SessionCookieOptions,
  returnPath: string,
): string {
  const state = randomBytes(32).toString("base64url");
  setCookie(
    c,
    OAUTH_STATE_COOKIE,
    `${state}.${encodeURIComponent(returnPath)}`,
    { ...attributes(options), maxAge: OAUTH_STATE_TTL_SECONDS },
  );
  return state;
}

/**
 * The return path of the sign-in whose cookie matches `state`, else null. A
 * missing cookie, a missing `state` and a mismatch are all null.
 */
export function matchOAuthState(
  c: Context,
  state: string | undefined,
): { returnPath: string } | null {
  const value = getCookie(c, OAUTH_STATE_COOKIE);
  if (value === undefined || state === undefined || state === "") return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const left = Buffer.from(value.slice(0, dot));
  const right = Buffer.from(state);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }
  try {
    return { returnPath: decodeURIComponent(value.slice(dot + 1)) };
  } catch {
    return null;
  }
}

export function clearOAuthState(c: Context, options: SessionCookieOptions) {
  deleteCookie(c, OAUTH_STATE_COOKIE, attributes(options));
}
