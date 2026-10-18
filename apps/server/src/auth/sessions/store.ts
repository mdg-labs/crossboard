import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, lte, notInArray } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { schema } from "../../db/index.js";

const { sessions, userTokens } = schema;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

export interface Session {
  userId: number;
  tokenHash: string;
}

export interface SessionLookup extends Session {
  /** True when the expiry was extended by this lookup. */
  refreshed: boolean;
}

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Stores a new session and returns the raw token for the cookie. */
export function createSession(
  db: Db,
  userId: number,
  now: number = Date.now(),
): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  db.insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
    })
    .run();
  return token;
}

/**
 * The live session a cookie token refers to, else null. A session last seen
 * an hour or more ago gets its `last_seen_at` and `expires_at` advanced.
 */
export function findSession(
  db: Db,
  token: string,
  now: number = Date.now(),
): SessionLookup | null {
  const tokenHash = hashToken(token);
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)),
      )
      .get();
    if (row === undefined) return null;
    const refreshed = now - row.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS;
    if (refreshed) {
      tx.update(sessions)
        .set({ lastSeenAt: now, expiresAt: now + SESSION_TTL_MS })
        .where(eq(sessions.tokenHash, tokenHash))
        .run();
    }
    return { userId: row.userId, tokenHash, refreshed };
  });
}

/**
 * Deletes the session a cookie token refers to. When the user is left with no
 * live session, their stored tokens go with it, in the same transaction.
 */
export function deleteSession(
  db: Db,
  token: string,
  now: number = Date.now(),
): void {
  const tokenHash = hashToken(token);
  db.transaction((tx) => {
    const row = tx
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .get();
    if (row === undefined) return;
    tx.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
    const live = tx
      .select({ total: count() })
      .from(sessions)
      .where(and(eq(sessions.userId, row.userId), gt(sessions.expiresAt, now)))
      .get();
    if (live === undefined || live.total === 0) {
      tx.delete(userTokens).where(eq(userTokens.userId, row.userId)).run();
    }
  });
}

/** Deletes expired sessions, then the tokens of users left without a session. */
export function cleanupSessions(
  db: Db,
  now: number = Date.now(),
): { sessions: number; tokens: number } {
  return db.transaction((tx) => {
    const expired = tx
      .delete(sessions)
      .where(lte(sessions.expiresAt, now))
      .run();
    const orphaned = tx
      .delete(userTokens)
      .where(
        notInArray(
          userTokens.userId,
          tx.select({ userId: sessions.userId }).from(sessions),
        ),
      )
      .run();
    return { sessions: expired.changes, tokens: orphaned.changes };
  });
}
