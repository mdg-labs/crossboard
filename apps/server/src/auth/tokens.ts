import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { GithubAppCredentials } from "../config/index.js";
import { schema, type Db } from "../db/index.js";
import { GithubError, type GithubClient } from "../github/index.js";
import { decrypt, encrypt } from "../security/index.js";

/** An access token with less time left than this is refreshed before use (FR-7). */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface UserTokensOptions {
  db: Db;
  github: Pick<GithubClient, "refreshOAuthToken">;
  /** The App credentials in effect now, else null. */
  credentials: () => GithubAppCredentials | null;
  appSecret: string;
  logger: Logger;
  now?: () => number;
}

export interface UserTokens {
  /**
   * A user access token that is valid for at least the refresh margin, else
   * null when the user has no usable tokens: none stored, an expired refresh
   * token, or a refresh token GitHub rejected (`bad_refresh_token`). In the
   * last two cases the user's tokens and sessions are deleted. A refresh that
   * fails for any other reason, such as rejected client credentials or a rate
   * limit, throws and changes nothing.
   */
  accessToken(userId: number): Promise<string | null>;
}

export function createUserTokens({
  db,
  github,
  credentials,
  appSecret,
  logger,
  now = Date.now,
}: UserTokensOptions): UserTokens {
  // Refresh tokens rotate on every use, so two concurrent refreshes for one
  // user would invalidate each other.
  const refreshing = new Map<number, Promise<string | null>>();

  function revoke(userId: number): void {
    db.transaction((tx) => {
      tx.delete(schema.sessions)
        .where(eq(schema.sessions.userId, userId))
        .run();
      tx.delete(schema.userTokens)
        .where(eq(schema.userTokens.userId, userId))
        .run();
    });
    logger.warn(
      { userId },
      "the user's GitHub tokens are no longer usable; their tokens and sessions were deleted",
    );
  }

  async function refresh(
    userId: number,
    refreshTokenEnc: string,
    refreshExpiresAt: number,
  ): Promise<string | null> {
    if (refreshExpiresAt <= now()) {
      revoke(userId);
      return null;
    }
    const app = credentials();
    if (app === null) {
      throw new Error("no GitHub App credentials to refresh a user token with");
    }
    let rotated;
    try {
      rotated = await github.refreshOAuthToken(
        app,
        decrypt(refreshTokenEnc, appSecret),
      );
    } catch (error) {
      if (error instanceof GithubError && error.code === "bad_refresh_token") {
        revoke(userId);
        return null;
      }
      throw error;
    }
    const stored = now();
    db.update(schema.userTokens)
      .set({
        accessTokenEnc: encrypt(rotated.accessToken, appSecret),
        accessExpiresAt: stored + rotated.expiresInSeconds * 1000,
        refreshTokenEnc: encrypt(rotated.refreshToken, appSecret),
        refreshExpiresAt: stored + rotated.refreshTokenExpiresInSeconds * 1000,
        updatedAt: stored,
      })
      .where(eq(schema.userTokens.userId, userId))
      .run();
    return rotated.accessToken;
  }

  return {
    async accessToken(userId) {
      // The read and the in-flight check share one synchronous step, so a
      // caller never starts a second refresh behind a finished first one.
      const row = db
        .select()
        .from(schema.userTokens)
        .where(eq(schema.userTokens.userId, userId))
        .get();
      if (row === undefined) return null;
      if (row.accessExpiresAt - now() >= ACCESS_TOKEN_REFRESH_MARGIN_MS) {
        return decrypt(row.accessTokenEnc, appSecret);
      }
      const running = refreshing.get(userId);
      if (running !== undefined) return running;
      const started = refresh(
        userId,
        row.refreshTokenEnc,
        row.refreshExpiresAt,
      ).finally(() => refreshing.delete(userId));
      refreshing.set(userId, started);
      return started;
    },
  };
}
