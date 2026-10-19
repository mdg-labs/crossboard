export const MANIFEST_EVENTS = [
  "issues",
  "issue_comment",
  "label",
  "sub_issues",
  "issue_dependencies",
  "repository",
] as const;

export interface ManifestInstance {
  publicUrl: string;
  webhooks: boolean;
  githubWebUrl: string;
}

export interface GithubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  public: true;
  request_oauth_on_install: false;
  hook_attributes: { url: string; active: boolean };
  default_permissions: { issues: "read"; metadata: "read" };
  default_events: readonly string[];
}

const withoutTrailingSlashes = (url: string) => url.replace(/\/+$/, "");

/** The default App name: `Crossboard (<host>)`. */
export const defaultAppName = (publicUrl: string) =>
  `Crossboard (${new URL(publicUrl).host})`;

/** The App manifest of SPEC FR-48; permissions and events follow SPEC §5.1. */
export function buildManifest(
  { publicUrl, webhooks }: ManifestInstance,
  name: string,
): GithubAppManifest {
  const base = withoutTrailingSlashes(publicUrl);
  return {
    name,
    url: base,
    redirect_url: `${base}/setup/callback`,
    callback_urls: [`${base}/auth/callback`],
    setup_url: `${base}/settings`,
    public: true,
    request_oauth_on_install: false,
    hook_attributes: { url: `${base}/webhooks/github`, active: webhooks },
    default_permissions: { issues: "read", metadata: "read" },
    default_events: MANIFEST_EVENTS,
  };
}

/** Where the operator's browser submits the manifest form. */
export function manifestTargetUrl(
  { githubWebUrl }: ManifestInstance,
  organization: string | undefined,
): string {
  const base = withoutTrailingSlashes(githubWebUrl);
  return organization === undefined
    ? `${base}/settings/apps/new`
    : `${base}/organizations/${organization}/settings/apps/new`;
}
