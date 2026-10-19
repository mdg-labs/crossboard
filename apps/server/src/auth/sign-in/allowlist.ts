import type { GithubClient } from "../../github/index.js";

export interface Allowlist {
  readonly users: readonly string[];
  readonly orgs: readonly string[];
}

/**
 * Whether a GitHub user may use this instance (SPEC FR-2): their login is in
 * the allowed users, or one of their installations of the App belongs to an
 * allowed org. Matching is case-insensitive. A failed lookup throws; it never
 * counts as "allowed".
 */
export async function isAllowedUser(
  github: Pick<GithubClient, "listUserInstallations">,
  allowlist: Allowlist,
  login: string,
  accessToken: string,
): Promise<boolean> {
  if (allowlist.users.includes(login.toLowerCase())) return true;
  if (allowlist.orgs.length === 0) return false;
  const installations = await github.listUserInstallations(accessToken);
  return installations.some(
    (installation) =>
      installation.account !== null &&
      allowlist.orgs.includes(installation.account.login.toLowerCase()),
  );
}
