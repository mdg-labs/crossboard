import type { Allowlist } from "../auth/sign-in/index.js";
import { schema, type Db } from "../db/index.js";

/**
 * The ids of the active installations (SPEC FR-3), derived from the database
 * on every call so it is never stale. An installation is active when its
 * account login is in either allowlist, or when at least one allowed user's
 * computed access includes it. A user is allowed (FR-2) when their login is in
 * the allowed users, or their computed access includes an installation of an
 * allowed org. Matching is case-insensitive; the allowlist is lowercased.
 */
export function activeInstallationIds(
  db: Pick<Db, "select">,
  allowlist: Allowlist,
): Set<number> {
  const allowedUsers = new Set(allowlist.users);
  const allowedOrgs = new Set(allowlist.orgs);

  const accountOf = new Map(
    db
      .select()
      .from(schema.installations)
      .all()
      .map((row) => [row.id, row.accountLogin.toLowerCase()]),
  );
  const links = db.select().from(schema.userInstallations).all();

  const orgUsers = new Set(
    links
      .filter((link) =>
        allowedOrgs.has(accountOf.get(link.installationId) ?? ""),
      )
      .map((link) => link.userId),
  );
  const allowedUserIds = new Set(
    db
      .select({ id: schema.users.id, login: schema.users.login })
      .from(schema.users)
      .all()
      .filter(
        (user) =>
          allowedUsers.has(user.login.toLowerCase()) || orgUsers.has(user.id),
      )
      .map((user) => user.id),
  );

  const active = new Set<number>();
  for (const [id, login] of accountOf) {
    if (allowedUsers.has(login) || allowedOrgs.has(login)) active.add(id);
  }
  for (const link of links) {
    if (allowedUserIds.has(link.userId)) active.add(link.installationId);
  }
  return active;
}
