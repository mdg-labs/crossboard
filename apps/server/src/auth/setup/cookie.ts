import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { deriveKey } from "../../security/index.js";

export const SETUP_COOKIE = "crossboard_setup";
export const SETUP_COOKIE_TTL_SECONDS = 30 * 60;

const COOKIE_KEY_INFO = "crossboard-setup-cookie-v1";

export interface SetupCookieOptions {
  appSecret: string;
  publicUrl: string;
}

const signingKey = (appSecret: string) =>
  deriveKey(appSecret, COOKIE_KEY_INFO).toString("base64url");

const isLocalHttp = (publicUrl: string) => {
  const url = new URL(publicUrl);
  return url.protocol === "http:" && url.hostname === "localhost";
};

/**
 * Sets the signed setup cookie. Its value is the expiry in epoch milliseconds,
 * followed by `:<state>` once the manifest form has been issued (SPEC FR-49).
 */
export async function issueSetupCookie(
  c: Context,
  { appSecret, publicUrl }: SetupCookieOptions,
  now: number = Date.now(),
  state?: string,
): Promise<void> {
  const expiresAt = now + SETUP_COOKIE_TTL_SECONDS * 1000;
  await setSignedCookie(
    c,
    SETUP_COOKIE,
    state === undefined ? String(expiresAt) : `${String(expiresAt)}:${state}`,
    signingKey(appSecret),
    {
      httpOnly: true,
      sameSite: "Lax",
      secure: !isLocalHttp(publicUrl),
      path: "/",
      maxAge: SETUP_COOKIE_TTL_SECONDS,
    },
  );
}

export interface SetupSession {
  /** The `state` of the manifest form issued with this cookie, if any. */
  state: string | undefined;
}

/** The setup session an untampered, unexpired setup cookie carries, else null. */
export async function readSetupCookie(
  c: Context,
  { appSecret }: Pick<SetupCookieOptions, "appSecret">,
  now: number = Date.now(),
): Promise<SetupSession | null> {
  const value = await getSignedCookie(c, signingKey(appSecret), SETUP_COOKIE);
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+)(?::([A-Za-z0-9_-]+))?$/.exec(value);
  if (match === null || Number(match[1]) <= now) {
    return null;
  }
  return { state: match[2] };
}

/** True when the request carries an untampered, unexpired setup cookie. */
export async function hasValidSetupCookie(
  c: Context,
  options: Pick<SetupCookieOptions, "appSecret">,
  now: number = Date.now(),
): Promise<boolean> {
  return (await readSetupCookie(c, options, now)) !== null;
}
