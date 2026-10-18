import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { activeInstallationIds } from "../access/index.js";
import type { SessionEnv } from "../auth/sessions/index.js";
import type { Setup } from "../auth/setup/index.js";
import { schema, type Db } from "../db/index.js";
import { errorResponse } from "./errors.js";

export interface MeOptions {
  db: Db;
  setup: Setup;
}

/**
 * `GET /api/me` (SPEC §7.4, FR-10): the session user, the installations in
 * their `user_installations` with the active flag (FR-3), and where to install
 * the App on more accounts. Nothing here comes from the token tables.
 */
export function createMeRoutes({ db, setup }: MeOptions) {
  return new Hono<SessionEnv>().get("/me", (c) => {
    const { userId } = c.var.session;
    const user = db
      .select({
        login: schema.users.login,
        name: schema.users.name,
        avatarUrl: schema.users.avatarUrl,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    if (user === undefined) {
      return errorResponse(
        c,
        401,
        "unauthorized",
        "Sign in to use this instance",
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
    const active = activeInstallationIds(db, setup.allowlist);
    const installations = db
      .select({
        id: schema.installations.id,
        accountLogin: schema.installations.accountLogin,
        accountType: schema.installations.accountType,
      })
      .from(schema.userInstallations)
      .innerJoin(
        schema.installations,
        eq(schema.userInstallations.installationId, schema.installations.id),
      )
      .where(eq(schema.userInstallations.userId, userId))
      .orderBy(asc(schema.installations.accountLogin))
      .all()
      .map((row) => ({ ...row, active: active.has(row.id) }));
    const installUrl = new URL(
      `/apps/${credentials.appSlug}/installations/new`,
      setup.instance.githubWebUrl,
    ).toString();
    return c.json({ user, installations, installUrl });
  });
}
