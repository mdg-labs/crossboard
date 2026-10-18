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

export async function issueSetupCookie(
  c: Context,
  { appSecret, publicUrl }: SetupCookieOptions,
  now: number = Date.now(),
): Promise<void> {
  const expiresAt = now + SETUP_COOKIE_TTL_SECONDS * 1000;
  await setSignedCookie(
    c,
    SETUP_COOKIE,
    String(expiresAt),
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

/** True when the request carries an untampered, unexpired setup cookie. */
export async function hasValidSetupCookie(
  c: Context,
  { appSecret }: Pick<SetupCookieOptions, "appSecret">,
  now: number = Date.now(),
): Promise<boolean> {
  const value = await getSignedCookie(c, signingKey(appSecret), SETUP_COOKIE);
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return false;
  }
  return Number(value) > now;
}
