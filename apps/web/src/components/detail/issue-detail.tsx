import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import {
  ExternalLink,
  githubOrigin,
  issueUrl,
  labelUrl,
  repoUrl,
  userUrl,
} from "@/components/detail/issue-link";
import { MarkdownBody } from "@/components/detail/markdown-body";
import { RelationList } from "@/components/detail/relation-list";
import { Section } from "@/components/detail/section";
import { issueTypeColors, labelColors } from "@/components/issue-list/colors";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  DetailError,
  type IssueDetails,
  type IssueRef,
  type IssueSummary,
  issueDetailsQuery,
  issueSummaryQuery,
} from "@/lib/issue-detail";
import { formatAbsoluteTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const refLabel = (ref: IssueRef): string =>
  `${ref.owner}/${ref.repo}#${String(ref.number)}`;

function QueryError({
  title,
  error,
  onRetry,
  retrying,
}: {
  title: string;
  error: Error | null;
  onRetry: () => void;
  retrying: boolean;
}): React.ReactElement {
  const detail =
    error instanceof DetailError &&
    error.status === 503 &&
    error.resetAt !== null
      ? `${error.message}. It resets at ${formatAbsoluteTime(error.resetAt)}.`
      : (error?.message ?? "Check your connection.");
  return (
    <Alert variant="error">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{detail}</p>
        <Button
          className="self-start"
          loading={retrying}
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function SummarySkeleton(): React.ReactElement {
  return (
    <div
      aria-busy="true"
      aria-label="Loading issue"
      className="flex flex-col gap-3"
      role="status"
    >
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
      </dd>
    </>
  );
}

function Person({
  login,
  avatarUrl,
  origin,
}: {
  login: string;
  avatarUrl: string | null;
  origin: string;
}): React.ReactElement {
  return (
    <ExternalLink
      className="inline-flex items-center gap-1.5 hover:underline"
      href={userUrl(origin, login)}
    >
      <Avatar className="size-5">
        {avatarUrl === null ? null : <AvatarImage alt="" src={avatarUrl} />}
        <AvatarFallback>{login.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      {login}
    </ExternalLink>
  );
}

function Summary({
  summary,
  onOpenIssue,
}: {
  summary: IssueSummary;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  const origin = githubOrigin(summary.url);
  const ref: IssueRef = {
    owner: summary.repo.owner,
    repo: summary.repo.name,
    number: summary.number,
  };

  return (
    <>
      <header className="flex flex-col gap-2 pb-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm">
            <Badge variant="success">Open</Badge>
            <ExternalLink
              className="text-muted-foreground tabular-nums hover:underline"
              href={summary.url}
            >
              {refLabel(ref)}
            </ExternalLink>
          </p>
          <Button
            render={
              <a href={summary.url} rel="noopener noreferrer" target="_blank" />
            }
            size="sm"
            variant="outline"
          >
            Open on GitHub
            <ExternalLinkIcon aria-hidden="true" />
          </Button>
        </div>
        <h2 className="font-semibold text-xl leading-snug">{summary.title}</h2>
      </header>
      <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2 pb-4 text-sm">
        <Field label="Repository">
          <ExternalLink
            className="hover:underline"
            href={repoUrl(origin, ref.owner, ref.repo)}
          >
            {ref.owner}/{ref.repo}
          </ExternalLink>
        </Field>
        <Field label="Author">
          <Person avatarUrl={null} login={summary.author} origin={origin} />
        </Field>
        <Field label="Created">
          <RelativeTime timestamp={summary.createdAt} />
        </Field>
        <Field label="Updated">
          <RelativeTime timestamp={summary.updatedAt} />
        </Field>
        {summary.type === null ? null : (
          <Field label="Type">
            <Badge style={issueTypeColors(summary.type.color)}>
              {summary.type.name}
            </Badge>
          </Field>
        )}
        {summary.milestone === null ? null : (
          <Field label="Milestone">
            <ExternalLink
              className="hover:underline"
              href={summary.milestone.url}
            >
              {summary.milestone.title}
            </ExternalLink>
          </Field>
        )}
        {summary.labels.length === 0 ? null : (
          <Field label="Labels">
            {summary.labels.map((label) => (
              <Badge
                key={label.name}
                render={
                  <a
                    href={labelUrl(origin, ref, label.name)}
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                style={labelColors(label.color)}
              >
                {label.name}
              </Badge>
            ))}
          </Field>
        )}
        {summary.assignees.length === 0 ? null : (
          <Field label="Assignees">
            {summary.assignees.map((assignee) => (
              <Person
                avatarUrl={assignee.avatarUrl}
                key={assignee.login}
                login={assignee.login}
                origin={origin}
              />
            ))}
          </Field>
        )}
        {summary.parent === null ? null : (
          <Field label="Parent">
            <ExternalLink
              className={cn(
                "hover:underline",
                summary.parent.state === "CLOSED" &&
                  "text-muted-foreground line-through",
              )}
              href={issueUrl(origin, {
                owner: summary.parent.owner,
                repo: summary.parent.repo,
                number: summary.parent.number,
              })}
            >
              {summary.parent.owner}/{summary.parent.repo}#
              {summary.parent.number} {summary.parent.title}
            </ExternalLink>
          </Field>
        )}
      </dl>
      <Section
        count={summary.blockedBy.open + summary.blockedBy.notAccessible}
        title="Blocked by"
      >
        <RelationList
          label="Blocked by"
          list={summary.blockedBy}
          onOpenIssue={onOpenIssue}
        />
      </Section>
      <Section
        count={summary.blocking.open + summary.blocking.notAccessible}
        title="Blocking"
      >
        <RelationList
          label="Blocking"
          list={summary.blocking}
          onOpenIssue={onOpenIssue}
        />
      </Section>
    </>
  );
}

function SubIssues({
  summary,
  details,
}: {
  summary: IssueSummary;
  details: IssueDetails;
}): React.ReactElement {
  const { subIssues } = details;
  const origin = githubOrigin(summary.url);
  const more =
    subIssues.total - subIssues.items.length - subIssues.notAccessible;
  const ref = {
    owner: summary.repo.owner,
    repo: summary.repo.name,
    number: summary.number,
  };

  return (
    <ul aria-label="Sub-issues" className="flex flex-col gap-1.5 text-sm">
      {subIssues.items.map((sub) => (
        <li
          className={cn(
            "flex items-baseline gap-2",
            sub.state === "CLOSED" && "text-muted-foreground line-through",
          )}
          key={`${sub.owner}/${sub.repo}#${String(sub.number)}`}
        >
          <ExternalLink
            className="shrink-0 text-muted-foreground tabular-nums hover:underline"
            href={sub.url}
          >
            {sub.owner}/{sub.repo}#{sub.number}
          </ExternalLink>
          <span className="min-w-0 truncate" title={sub.title}>
            {sub.title}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {sub.state.toLowerCase()}
          </span>
        </li>
      ))}
      {subIssues.notAccessible > 0 ? (
        <li className="text-muted-foreground">
          +{subIssues.notAccessible} not accessible
        </li>
      ) : null}
      {more > 0 ? (
        <li>
          <ExternalLink
            className="text-muted-foreground hover:underline"
            href={issueUrl(origin, ref)}
          >
            +{more} more on GitHub
          </ExternalLink>
        </li>
      ) : null}
    </ul>
  );
}

function Comments({
  summary,
  details,
}: {
  summary: IssueSummary;
  details: IssueDetails;
}): React.ReactElement {
  const origin = githubOrigin(summary.url);
  const earlier = details.commentsTotal - details.comments.length;

  return (
    <ol aria-label="Comments" className="flex flex-col gap-4">
      {earlier > 0 ? (
        <li className="text-sm">
          <ExternalLink
            className="text-muted-foreground hover:underline"
            href={summary.url}
          >
            {earlier} earlier {earlier === 1 ? "comment" : "comments"} on GitHub
          </ExternalLink>
        </li>
      ) : null}
      {details.comments.map((comment) => (
        <li className="flex flex-col gap-2" key={comment.url}>
          <div className="flex items-center gap-2 text-sm">
            <Person
              avatarUrl={comment.avatarUrl}
              login={comment.author}
              origin={origin}
            />
            <ExternalLink
              className="text-muted-foreground hover:underline"
              href={comment.url}
            >
              <RelativeTime timestamp={comment.createdAt} />
            </ExternalLink>
          </div>
          <MarkdownBody html={comment.bodyHtml} />
        </li>
      ))}
    </ol>
  );
}

/**
 * One issue's detail (SPEC FR-40): the summary at once, the lazily fetched
 * body, sub-issues and comments when they arrive (FR-42). It fills a Drawer
 * over the list and the `/i/:owner/:repo/:number` page alike.
 */
export function IssueDetail({
  issue,
  onOpenIssue,
}: {
  issue: IssueRef;
  /** Opens a synced issue's detail, where the host decides what that means. */
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  const summary = useQuery(issueSummaryQuery(issue));
  const details = useQuery(issueDetailsQuery(issue));

  if (summary.isPending) {
    return <SummarySkeleton />;
  }
  if (summary.data === undefined) {
    const notFound =
      summary.error instanceof DetailError && summary.error.status === 404;
    return notFound ? (
      <Alert variant="error">
        <AlertTitle>No detail for {refLabel(issue)}</AlertTitle>
        <AlertDescription>
          <p>
            This issue is not synced or you cannot access it. Only open issues
            of repositories you can reach have a detail view.
          </p>
        </AlertDescription>
      </Alert>
    ) : (
      <QueryError
        error={summary.error}
        onRetry={() => void summary.refetch()}
        retrying={summary.isFetching}
        title="Could not load the issue"
      />
    );
  }

  const data = summary.data;
  let subIssues: React.ReactNode = null;
  if (data.subIssues.total > 0) {
    subIssues = (
      <Section count={data.subIssues.total} title="Sub-issues">
        {details.data === undefined ? (
          <p className="text-muted-foreground text-sm">
            {data.subIssues.completed} of {data.subIssues.total} completed
          </p>
        ) : (
          <SubIssues details={details.data} summary={data} />
        )}
      </Section>
    );
  }

  let body: React.ReactNode;
  if (details.data !== undefined) {
    body = (
      <>
        {details.data.stale ? (
          <Alert variant="warning">
            <AlertTitle>This copy may be out of date</AlertTitle>
            <AlertDescription>
              <p>GitHub could not be reached to refresh it.</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {details.data.bodyHtml === "" ? (
          <p className="text-muted-foreground text-sm">
            No description provided.
          </p>
        ) : (
          <MarkdownBody html={details.data.bodyHtml} />
        )}
      </>
    );
  } else if (details.isPending) {
    body = (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading description
      </div>
    );
  } else {
    body = (
      <QueryError
        error={details.error}
        onRetry={() => void details.refetch()}
        retrying={details.isFetching}
        title="Could not load the description and comments"
      />
    );
  }

  return (
    <div className="flex flex-col">
      <Summary onOpenIssue={onOpenIssue} summary={data} />
      {subIssues}
      <Section title="Description">{body}</Section>
      {details.data !== undefined && details.data.commentsTotal > 0 ? (
        <Section count={details.data.commentsTotal} title="Comments">
          <Comments details={details.data} summary={data} />
        </Section>
      ) : null}
    </div>
  );
}
