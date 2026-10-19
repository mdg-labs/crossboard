import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  githubOrigin,
  issueUrl,
} from "@/components/detail/issue-link";
import { DependencyGraph } from "@/components/detail/dependency-graph/dependency-graph";
import { hasDependencies } from "@/components/detail/dependency-graph/layout";
import { MarkdownBody } from "@/components/detail/markdown-body";
import { Person } from "@/components/detail/person";
import { PropertiesRail } from "@/components/detail/properties-rail";
import { RelationList } from "@/components/detail/relation-list";
import { Section } from "@/components/detail/section";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

function IssueHeading({
  summary,
  className,
}: {
  summary: IssueSummary;
  className?: string;
}): React.ReactElement {
  const ref: IssueRef = {
    owner: summary.repo.owner,
    repo: summary.repo.name,
    number: summary.number,
  };

  return (
    <header className={cn("flex flex-col gap-2 pb-4", className)}>
      <p className="flex items-center gap-2 text-sm">
        <Badge variant="success">Open</Badge>
        <ExternalLink
          className="text-muted-foreground tabular-nums hover:underline"
          href={summary.url}
        >
          {refLabel(ref)}
        </ExternalLink>
      </p>
      <h2 className="font-semibold text-xl leading-snug">{summary.title}</h2>
    </header>
  );
}

function Relations({
  summary,
  onOpenIssue,
}: {
  summary: IssueSummary;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  return (
    <>
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
      {hasDependencies(summary) ? (
        <Section title="Dependency graph">
          <DependencyGraph onOpenIssue={onOpenIssue} summary={summary} />
        </Section>
      ) : null}
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
  wide = false,
}: {
  issue: IssueRef;
  /** Opens a synced issue's detail, where the host decides what that means. */
  onOpenIssue: (issue: IssueRef) => void;
  /** Full-width layout: the fields move into a rail beside the content (from `lg` up). */
  wide?: boolean;
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
    <div
      className={cn(
        "flex flex-col",
        wide &&
          "lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:grid-rows-[auto_1fr] lg:gap-x-8",
      )}
    >
      <IssueHeading
        className={wide ? "lg:col-start-1 lg:row-start-1" : undefined}
        summary={data}
      />
      <PropertiesRail
        className={cn(
          "pb-4",
          wide &&
            "lg:sticky lg:top-0 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start lg:border-s lg:pb-0 lg:ps-6",
        )}
        summary={data}
      />
      <div className={cn("min-w-0", wide && "lg:col-start-1 lg:row-start-2")}>
        <Relations onOpenIssue={onOpenIssue} summary={data} />
        {subIssues}
        <Section title="Description">{body}</Section>
        {details.data !== undefined && details.data.commentsTotal > 0 ? (
          <Section count={details.data.commentsTotal} title="Comments">
            <Comments details={details.data} summary={data} />
          </Section>
        ) : null}
      </div>
    </div>
  );
}
