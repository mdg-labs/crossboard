import { ExternalLinkIcon } from "lucide-react";
import {
  assigneeQualifier,
  labelQualifier,
  repoQualifier,
} from "@/components/filter-bar/qualifiers";
import { issueTypeColors, labelColors } from "@/components/issue-list/colors";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TableCell, TableRow } from "@/components/ui/table";
import type { IssueItem } from "@/lib/issues";

/** Every row is exactly this tall: the virtualizer does not measure rows. */
export const ROW_HEIGHT = 44;

const relationCount = (relations: IssueItem["blockedBy"]): number =>
  relations.open + relations.notAccessible;

export function IssueRow({
  issue,
  selected,
  onFilter,
}: {
  issue: IssueItem;
  selected: boolean;
  /** Adds a qualifier to the filter (SPEC FR-15). */
  onFilter: (qualifier: string) => void;
}): React.ReactElement {
  const repo = `${issue.repo.owner}/${issue.repo.name}`;
  const blockedBy = relationCount(issue.blockedBy);
  const blocking = relationCount(issue.blocking);

  return (
    <TableRow
      aria-current={selected ? "true" : undefined}
      className="[&>td]:h-11 [&>td]:border-b [&>td]:py-0"
      data-issue-id={issue.id}
      data-state={selected ? "selected" : undefined}
    >
      <TableCell className="truncate">
        <Button
          className="-mx-2 max-w-full justify-start font-normal text-muted-foreground"
          onClick={() => onFilter(repoQualifier(issue.repo))}
          size="xs"
          title={`Filter by ${repo}`}
          variant="link"
        >
          <span className="truncate">{repo}</span>
        </Button>
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        #{issue.number}
      </TableCell>
      <TableCell className="truncate font-medium" title={issue.title}>
        {issue.title}
      </TableCell>
      <TableCell>
        {issue.type === null ? null : (
          <Badge style={issueTypeColors(issue.type.color)}>
            {issue.type.name}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex gap-1 overflow-hidden">
          {issue.labels.map((label) => {
            const qualifier = labelQualifier(label.name);
            return qualifier === null ? (
              <Badge key={label.name} style={labelColors(label.color)}>
                {label.name}
              </Badge>
            ) : (
              <Badge
                key={label.name}
                render={
                  <button
                    onClick={() => onFilter(qualifier)}
                    title={`Filter by label ${label.name}`}
                    type="button"
                  />
                }
                style={labelColors(label.color)}
              >
                {label.name}
              </Badge>
            );
          })}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex -space-x-1.5">
          {issue.assignees.map((assignee) => (
            <Avatar
              className="size-5 cursor-pointer ring-2 ring-background outline-none focus-visible:ring-ring"
              key={assignee.login}
              render={
                <button
                  onClick={() => onFilter(assigneeQualifier(assignee.login))}
                  title={`Filter by assignee ${assignee.login}`}
                  type="button"
                />
              }
            >
              <AvatarImage alt={assignee.login} src={assignee.avatarUrl} />
              <AvatarFallback>
                {assignee.login.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          ))}
        </div>
      </TableCell>
      <TableCell
        className="truncate text-muted-foreground"
        title={issue.milestone?.title}
      >
        {issue.milestone?.title}
      </TableCell>
      <TableCell>
        <div className="flex gap-1 overflow-hidden">
          {issue.isBlocked ? (
            <Badge variant="destructive">blocked</Badge>
          ) : null}
          {blockedBy > 0 ? (
            <Badge variant="outline">blocked by {blockedBy}</Badge>
          ) : null}
          {blocking > 0 ? (
            <Badge variant="outline">blocks {blocking}</Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {issue.subIssues.total > 0 ? (
          <div className="flex items-center gap-2">
            <Progress
              aria-label="Sub-issues completed"
              max={issue.subIssues.total}
              value={issue.subIssues.completed}
            />
            <span className="text-muted-foreground text-xs tabular-nums">
              {issue.subIssues.completed}/{issue.subIssues.total}
            </span>
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground">
        <RelativeTime timestamp={issue.updatedAt} />
      </TableCell>
      <TableCell>
        <Button
          aria-label={`Open ${repo}#${issue.number} on GitHub`}
          render={<a href={issue.url} rel="noreferrer" target="_blank" />}
          size="icon-xs"
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
