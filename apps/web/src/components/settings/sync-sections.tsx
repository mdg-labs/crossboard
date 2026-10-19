import { useQuery } from "@tanstack/react-query";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAbsoluteTime } from "@/lib/time";
import {
  syncQuery,
  type SyncBudget,
  type SyncInstallation,
  type SyncState,
} from "@/lib/sync";

const STATE_BADGES: Record<
  SyncState,
  {
    label: string;
    variant: "success" | "info" | "outline" | "error" | "warning";
  }
> = {
  pending: { label: "Pending", variant: "outline" },
  syncing: { label: "Syncing", variant: "info" },
  ready: { label: "Ready", variant: "success" },
  error: { label: "Error", variant: "error" },
  skipped: { label: "Skipped", variant: "warning" },
};

function SyncError({
  title,
  isFetching,
  onRetry,
}: {
  title: string;
  isFetching: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="error">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>Check your connection and try again.</p>
        <Button
          className="mt-2"
          loading={isFetching}
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

function Loading({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="flex flex-col gap-2"
      role="status"
    >
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

/** Per-repo sync state (SPEC FR-46). */
export function RepositoriesCard(): React.ReactElement {
  const sync = useQuery(syncQuery);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repositories</CardTitle>
        <CardDescription>
          Where each repository you can reach is in the sync.
        </CardDescription>
      </CardHeader>
      <CardPanel>
        {sync.isPending ? (
          <Loading label="Loading repositories" />
        ) : sync.isError ? (
          <SyncError
            isFetching={sync.isFetching}
            onRetry={() => void sync.refetch()}
            title="Could not load the sync state"
          />
        ) : sync.data.repos.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No repositories yet</EmptyTitle>
              <EmptyDescription>
                Repositories appear here once the App is installed on an account
                you can reach and its installation is active.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Last synced</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sync.data.repos.map((repo) => {
                const badge = STATE_BADGES[repo.state];
                return (
                  <TableRow key={`${repo.owner}/${repo.name}`}>
                    <TableCell className="font-medium">
                      {repo.owner}/{repo.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {repo.lastSyncedAt === null ? (
                        "Never"
                      ) : (
                        <RelativeTime timestamp={repo.lastSyncedAt} />
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {repo.detail ?? ""}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardPanel>
    </Card>
  );
}

const NUMBER = new Intl.NumberFormat();

function BudgetLine({
  label,
  budget,
}: {
  label: string;
  budget: SyncBudget | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">
        {budget === null ? (
          "Unknown"
        ) : (
          <>
            {NUMBER.format(budget.remaining)}
            {budget.limit === null
              ? ""
              : ` of ${NUMBER.format(budget.limit)}`}{" "}
            remaining
            {budget.resetAt === null ? null : (
              <>
                , resets{" "}
                <time dateTime={new Date(budget.resetAt).toISOString()}>
                  {formatAbsoluteTime(budget.resetAt)}
                </time>
              </>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

function BudgetCard({ installation }: { installation: SyncInstallation }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{installation.accountLogin}</CardTitle>
      </CardHeader>
      <CardPanel>
        <dl className="flex flex-col gap-3">
          <BudgetLine budget={installation.rest} label="REST requests" />
          <BudgetLine budget={installation.graphql} label="GraphQL points" />
        </dl>
      </CardPanel>
    </Card>
  );
}

/** Each active installation's remaining GitHub budget (SPEC FR-46). */
export function BudgetsSection(): React.ReactElement {
  const sync = useQuery(syncQuery);

  return (
    <section aria-label="GitHub budget" className="flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-lg">GitHub budget</h2>
        <p className="text-muted-foreground text-sm">
          What each active installation has left of its hourly allowance. It
          shows Unknown until the first GitHub call after a restart.
        </p>
      </div>
      {sync.isPending ? (
        <Loading label="Loading budgets" />
      ) : sync.isError ? (
        <SyncError
          isFetching={sync.isFetching}
          onRetry={() => void sync.refetch()}
          title="Could not load the GitHub budgets"
        />
      ) : sync.data.installations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No active installations</EmptyTitle>
            <EmptyDescription>
              A budget is shown for each installation that is being synced.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sync.data.installations.map((installation) => (
            <BudgetCard installation={installation} key={installation.id} />
          ))}
        </div>
      )}
    </section>
  );
}
