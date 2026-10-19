import { type IssueRef, detailPath } from "@/lib/issue-detail";

/** The origin GitHub links of an issue are built on, from the issue's own URL. */
export function githubOrigin(issueUrl: string): string {
  try {
    return new URL(issueUrl).origin;
  } catch {
    return "https://github.com";
  }
}

export const userUrl = (origin: string, login: string): string =>
  `${origin}/${encodeURIComponent(login)}`;

export const repoUrl = (origin: string, owner: string, repo: string): string =>
  `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export const issueUrl = (origin: string, ref: IssueRef): string =>
  `${repoUrl(origin, ref.owner, ref.repo)}/issues/${String(ref.number)}`;

export const labelUrl = (origin: string, ref: IssueRef, name: string): string =>
  `${repoUrl(origin, ref.owner, ref.repo)}/labels/${encodeURIComponent(name)}`;

/** A link that leaves for GitHub in a new tab. */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      className={className}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

/**
 * A link to an issue: a synced one opens its detail in the app, any other
 * goes to GitHub (SPEC FR-39).
 */
export function IssueLink({
  issue,
  url,
  synced,
  onOpenIssue,
  className,
  children,
}: {
  issue: IssueRef;
  url: string;
  synced: boolean;
  onOpenIssue: (issue: IssueRef) => void;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  if (!synced) {
    return (
      <ExternalLink className={className} href={url}>
        {children}
      </ExternalLink>
    );
  }
  return (
    <a
      className={className}
      href={detailPath(issue)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onOpenIssue({
          owner: issue.owner,
          repo: issue.repo,
          number: issue.number,
        });
      }}
    >
      {children}
    </a>
  );
}
