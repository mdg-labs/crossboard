import { Hono } from "hono";
import type { Logger } from "pino";
import { createAccess } from "../../access/index.js";
import { errorResponse } from "../../api/errors.js";
import { schema, type Db } from "../../db/index.js";
import { GithubError, type GithubClient } from "../../github/index.js";
import { encrypt } from "../../security/index.js";
import {
  createSession,
  sanitizeReturnPath,
  setSessionCookie,
  type SessionCookieOptions,
} from "../sessions/index.js";
import type { Setup } from "../setup/index.js";
import { createUserTokens } from "../tokens.js";
import { isAllowedUser } from "./allowlist.js";
import { clearOAuthState, issueOAuthState, matchOAuthState } from "./state.js";

export interface SignInRoutesOptions extends SessionCookieOptions {
  db: Db;
  github: GithubClient;
  setup: Setup;
  logger: Logger;
  appSecret: string;
}

export const NOT_ALLOWED_PATH = "/auth/not-allowed";

const callbackUrl = (publicUrl: string) =>
  `${publicUrl.replace(/\/+$/, "")}/auth/callback`;

/**
 * `GET /auth/login` and `GET /auth/callback` (SPEC FR-4): the App's OAuth web
 * flow. The callback admits only allowed users (FR-2); for anyone else it
 * stores nothing.
 */
export function createSignInRoutes({
  db,
  github,
  setup,
  logger,
  appSecret,
  publicUrl,
}: SignInRoutesOptions) {
  const cookieOptions = { publicUrl };
  const access = createAccess({
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

  return new Hono()
    .get("/login", (c) => {
      const credentials = setup.credentials();
      if (credentials === null) {
        return errorResponse(
          c,
          503,
          "service_unavailable",
          "This instance has no GitHub App configured",
        );
      }
      const state = issueOAuthState(
        c,
        cookieOptions,
        sanitizeReturnPath(c.req.query("return")),
      );
      const authorize = new URL(
        "/login/oauth/authorize",
        setup.instance.githubWebUrl,
      );
      authorize.searchParams.set("client_id", credentials.clientId);
      authorize.searchParams.set("redirect_uri", callbackUrl(publicUrl));
      authorize.searchParams.set("state", state);
      return c.redirect(authorize.toString(), 302);
    })
    .get("/callback", async (c) => {
      const matched = matchOAuthState(c, c.req.query("state"));
      if (matched === null) {
        return errorResponse(c, 400, "invalid_state", "The state is invalid");
      }
      clearOAuthState(c, cookieOptions);

      const code = c.req.query("code");
      if (code === undefined || code === "" || c.req.query("error")) {
        return errorResponse(
          c,
          400,
          "bad_request",
          "GitHub did not authorize the sign-in",
        );
      }
      const credentials = setup.credentials();
      if (credentials === null) {
        return errorResponse(
          c,
          503,
          "service_unavailable",
          "This instance has no GitHub App configured",
        );
      }

      let tokens, user, allowed;
      try {
        tokens = await github.exchangeOAuthCode(
          credentials,
          code,
          callbackUrl(publicUrl),
        );
        user = await github.getUser(tokens.accessToken);
        allowed = await isAllowedUser(
          github,
          setup.allowlist,
          user.login,
          tokens.accessToken,
        );
      } catch (error) {
        if (error instanceof GithubError) {
          return errorResponse(
            c,
            502,
            "bad_gateway",
            `GitHub could not complete the sign-in: ${error.githubMessage}`,
          );
        }
        throw error;
      }

      if (!allowed) {
        logger.info(
          { login: user.login },
          "a sign-in was rejected: the account is not allowed",
        );
        return c.redirect(NOT_ALLOWED_PATH, 302);
      }

      const now = Date.now();
      const signedIn = db.transaction((tx) => {
        const row = tx
          .insert(schema.users)
          .values({
            githubId: user.id,
            login: user.login,
            name: user.name,
            avatarUrl: user.avatarUrl ?? "",
            createdAt: now,
            lastLoginAt: now,
          })
          .onConflictDoUpdate({
            target: schema.users.githubId,
            set: {
              login: user.login,
              name: user.name,
              avatarUrl: user.avatarUrl ?? "",
              lastLoginAt: now,
            },
          })
          .returning({ id: schema.users.id })
          .get();
        const stored = {
          accessTokenEnc: encrypt(tokens.accessToken, appSecret),
          accessExpiresAt: now + tokens.expiresInSeconds * 1000,
          refreshTokenEnc: encrypt(tokens.refreshToken, appSecret),
          refreshExpiresAt: now + tokens.refreshTokenExpiresInSeconds * 1000,
          updatedAt: now,
        };
        tx.insert(schema.userTokens)
          .values({ userId: row.id, ...stored })
          .onConflictDoUpdate({ target: schema.userTokens.userId, set: stored })
          .run();
        return { token: createSession(tx, row.id, now), userId: row.id };
      });
      // A failure leaves the access computed before (none for a new user)
      // until the next hourly run retries.
      try {
        await access.compute(signedIn.userId);
      } catch (error) {
        logger.error(
          { err: error, userId: signedIn.userId },
          "computing the user's access at sign-in failed",
        );
      }
      setSessionCookie(c, cookieOptions, signedIn.token);
      logger.info({ userId: signedIn.userId }, "user signed in");
      return c.redirect(sanitizeReturnPath(matched.returnPath), 302);
    });
}
