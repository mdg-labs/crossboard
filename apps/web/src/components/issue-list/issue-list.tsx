import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { IssueTable } from "@/components/issue-list/issue-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { loadedIssues, issuesQuery, SORT_ITEMS, type Sort } from "@/lib/issues";
import { meQuery } from "@/lib/me";

const SKELETON_ROWS = 10;

function EmptyIssues(): React.ReactElement {
  const me = useQuery(meQuery);
  const noActiveInstallation =
    me.data !== undefined && !me.data.installations.some((i) => i.active);

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No open issues match this filter</EmptyTitle>
        {noActiveInstallation ? (
          <EmptyDescription>
            Install the Crossboard GitHub App on your account or an organization
            to bring its issues here.
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {noActiveInstallation ? (
        <EmptyContent>
          <Button
            render={<a href={me.data.installUrl} rel="noreferrer" />}
            size="sm"
          >
            Install the App
            <ExternalLinkIcon aria-hidden="true" />
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

export function IssueList({
  q,
  sort,
  onSortChange,
  onFilter,
}: {
  q: string;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  onFilter: (qualifier: string) => void;
}): React.ReactElement {
  const issues = useInfiniteQuery(issuesQuery(q, sort));
  const items = loadedIssues(issues.data);
  const total = issues.data?.pages[0]?.total;
  const { fetchNextPage } = issues;

  let body: React.ReactElement;
  if (issues.isPending) {
    body = (
      <div
        aria-busy="true"
        aria-label="Loading issues"
        className="flex flex-col gap-1 p-4"
        role="status"
      >
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton className="h-10 w-full" key={index} />
        ))}
      </div>
    );
  } else if (issues.data === undefined) {
    body = (
      <div className="p-4">
        <Alert variant="error">
          <AlertTitle>Could not load issues</AlertTitle>
          <AlertDescription>
            <p>{issues.error?.message ?? "Check your connection."}</p>
            <Button
              className="self-start"
              loading={issues.isFetching}
              onClick={() => void issues.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  } else if (items.length === 0) {
    body = <EmptyIssues />;
  } else {
    body = (
      <>
        <IssueTable
          hasMore={issues.hasNextPage && !issues.isFetchNextPageError}
          items={items}
          loadingMore={issues.isFetchingNextPage}
          onFilter={onFilter}
          onLoadMore={() => void fetchNextPage()}
        />
        {issues.isFetchNextPageError ? (
          <div className="border-t p-2">
            <Alert variant="error">
              <AlertTitle>Could not load more issues</AlertTitle>
              <AlertDescription>
                <p>{issues.error?.message}</p>
                <Button
                  className="self-start"
                  onClick={() => void fetchNextPage()}
                  size="sm"
                  variant="outline"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section aria-label="Issues" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2">
        <p className="text-muted-foreground text-sm" role="status">
          {total === undefined
            ? ""
            : `${total.toLocaleString("en-US")} ${total === 1 ? "issue" : "issues"}`}
        </p>
        <div className="flex items-center gap-4">
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <KbdGroup>
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
            </KbdGroup>
            move
            <Kbd>o</Kbd>
            open on GitHub
          </p>
          <Select
            items={SORT_ITEMS}
            onValueChange={(value) => {
              if (value !== null) {
                onSortChange(value);
              }
            }}
            value={sort}
          >
            <SelectTrigger aria-label="Sort issues" className="w-56" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SORT_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {body}
    </section>
  );
}
