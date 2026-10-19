import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import {
  assigneeQualifier,
  labelQualifier,
  repoQualifier,
} from "@/components/filter-bar/qualifiers";
import { issueTypeColors, labelColors } from "@/components/issue-list/colors";
import { BlockedMarker } from "@/components/blocked-marker";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { TableCell, TableRow } from "@/components/ui/table";
import type { IssueRef } from "@/lib/issue-detail";
import type { IssueItem } from "@/lib/issues";

/** Every row is exactly this tall: the virtualizer does not measure rows. */
export const ROW_HEIGHT = 44;

const relationCount = (relations: IssueItem["blockedBy"]): number =>
  relations.open + relations.notAccessible;

/** Indent of each nesting level, in rem. */
const INDENT_REM = 1.25;

export interface RowNesting {
  depth: number;
  /** The listed issue this row is nested under. */
  under: IssueItem | null;
  expandable: boolean;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

const sameRef = (parent: NonNullable<IssueItem["parent"]>, issue: IssueItem) =>
  parent.owner.toLowerCase() === issue.repo.owner.toLowerCase() &&
  parent.repo.toLowerCase() === issue.repo.name.toLowerCase() &&
  parent.number === issue.number;

/**
 * One row of the list (SPEC FR-12). `nesting` is given in nesting mode: the
 * row is indented by its depth and an issue with sub-issues has a toggle. A
 * row shows its parent below the title unless it is nested right under it.
 */
export function IssueRow({
  issue,
  selected,
  nesting,
  onFilter,
  onOpen,
  onOpenRef,
}: {
  issue: IssueItem;
  selected: boolean;
  nesting?: RowNesting;
  /** Opens the issue's detail (SPEC FR-39). */
  onOpen: (issue: IssueItem) => void;
  /** Opens the detail of an issue named only by its place on GitHub. */
  onOpenRef: (ref: IssueRef) => void;
  /** Adds a qualifier to the filter (SPEC FR-15). */
  onFilter: (qualifier: string) => void;
}): React.ReactElement {
  const repo = `${issue.repo.owner}/${issue.repo.name}`;
  const { parent } = issue;
  const showParent =
    parent !== null &&
    !(nesting?.under != null && sameRef(parent, nesting.under));
  const blockedBy = relationCount(issue.blockedBy);
  const blocking = relationCount(issue.blocking);

  return (
    <TableRow
      aria-current={selected ? "true" : undefined}
      className="cursor-pointer hover:bg-accent! data-blocked:*:first:shadow-[inset_3px_0_0_0_var(--destructive)] data-[state=selected]:bg-primary/10! data-[state=selected]:hover:bg-primary/15! [&>td]:h-11 [&>td]:border-b [&>td]:py-0"
      data-blocked={issue.isBlocked ? "true" : undefined}
      data-issue-id={issue.id}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("a, button") === null
        ) {
          onOpen(issue);
        }
      }}
      data-state={selected ? "selected" : undefined}
    >
      <TableCell className="truncate">
        <div className="flex min-w-0 items-center gap-1">
          <BlockedMarker issue={issue} />
          <Button
            className="-mx-1 min-w-0 justify-start font-normal text-muted-foreground"
            onClick={() => onFilter(repoQualifier(issue.repo))}
            size="xs"
            title={`Filter by ${repo}`}
            variant="link"
          >
            <span className="truncate">{repo}</span>
          </Button>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        #{issue.number}
      </TableCell>
      <TableCell
        style={
          nesting === undefined || nesting.depth === 0
            ? undefined
            : { paddingLeft: `${String(nesting.depth * INDENT_REM)}rem` }
        }
      >
        <div className="flex items-center gap-1">
          {nesting === undefined ? null : nesting.expandable ? (
            <Collapsible
              onOpenChange={nesting.onToggle}
              open={nesting.expanded}
            >
              <CollapsibleTrigger
                aria-label={`${nesting.expanded ? "Collapse" : "Expand"} sub-issues of ${repo}#${String(issue.number)}`}
                className="group -ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 transition-transform group-data-panel-open:rotate-90"
                />
              </CollapsibleTrigger>
            </Collapsible>
          ) : (
            <span aria-hidden="true" className="-ml-1 size-5 shrink-0" />
          )}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium" title={issue.title}>
              {issue.title}
            </span>
            {showParent ? (
              <Button
                className="-mx-2 h-4 max-w-full justify-start px-2 font-normal text-muted-foreground text-xs"
                onClick={() =>
                  onOpenRef({
                    owner: parent.owner,
                    repo: parent.repo,
                    number: parent.number,
                  })
                }
                size="xs"
                title={`Open the parent ${parent.owner}/${parent.repo}#${String(parent.number)}`}
                variant="link"
              >
                <span aria-hidden="true">↳</span>
                <span className="truncate">
                  {parent.owner}/{parent.repo}#{parent.number}
                </span>
              </Button>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell>
        {issue.type === null ? null : (
          <Badge style={issueTypeColors(issue.type.color)}>
            {issue.type.name}
          </Badge>
        )}
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
    </TableRow>
  );
}
