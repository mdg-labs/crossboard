import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
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
import {
  BudgetsSection,
  RepositoriesCard,
} from "@/components/settings/sync-sections";
import { meQuery } from "@/lib/me";

function InstallLink({
  href,
  label,
  variant,
}: {
  href: string;
  label: string;
  variant: "default" | "outline";
}) {
  return (
    <Button
      render={<a href={href} rel="noreferrer" />}
      size="sm"
      variant={variant}
    >
      {label}
      <ExternalLinkIcon aria-hidden="true" />
    </Button>
  );
}

export function SettingsRoute(): React.ReactElement {
  const me = useQuery(meQuery);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="font-semibold text-xl">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Installations</CardTitle>
          <CardDescription>
            The accounts and organizations where the Crossboard GitHub App is
            installed and that you can reach.
          </CardDescription>
          {me.data !== undefined && me.data.installations.length > 0 ? (
            <CardAction>
              <InstallLink
                href={me.data.installUrl}
                label="Install on more accounts"
                variant="outline"
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardPanel>
          {me.isPending ? (
            <div
              aria-busy="true"
              aria-label="Loading installations"
              className="flex flex-col gap-2"
              role="status"
            >
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : me.isError ? (
            <Alert variant="error">
              <AlertTitle>Could not load your installations</AlertTitle>
              <AlertDescription>
                <p>Check your connection and try again.</p>
                <Button
                  className="mt-2"
                  loading={me.isFetching}
                  onClick={() => void me.refetch()}
                  size="sm"
                  variant="outline"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : me.data.installations.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>The App is not installed anywhere yet</EmptyTitle>
                <EmptyDescription>
                  Install the Crossboard GitHub App on your account or an
                  organization and choose the repositories to include. After
                  installing, GitHub brings you back here.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <InstallLink
                  href={me.data.installUrl}
                  label="Install the App"
                  variant="default"
                />
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {me.data.installations.map((installation) => (
                  <TableRow key={installation.id}>
                    <TableCell className="font-medium">
                      {installation.accountLogin}
                    </TableCell>
                    <TableCell>{installation.accountType}</TableCell>
                    <TableCell>
                      <Badge
                        variant={installation.active ? "success" : "outline"}
                      >
                        {installation.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardPanel>
      </Card>
      <RepositoriesCard />
      <BudgetsSection />
    </div>
  );
}
