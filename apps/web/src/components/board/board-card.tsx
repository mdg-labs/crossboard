import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { issueTypeColors, labelColors } from "@/components/issue-list/colors";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import type { BoardCard as CardData } from "@/lib/board-cards";
import type { IssueRef } from "@/lib/issue-detail";

export interface CardActions {
  onOpen: (issue: IssueRef) => void;
  isExpanded: (cardId: string) => boolean;
  setExpanded: (cardId: string, expanded: boolean) => void;
}

/**
 * One card of a board column (SPEC FR-32): repo, number, title, the parent in
 * expanded mode, labels, assignees, type, the blocked badge and sub-issue
 * progress. In collapsed mode
 * a card with nested sub-issues has a toggle that lists them below it; the
 * nested cards can expand in turn (FR-31).
 */
export function BoardCard({
  card,
  actions,
}: {
  card: CardData;
  actions: CardActions;
}): React.ReactElement {
  const repo = `${card.repo.owner}/${card.repo.name}`;
  const ref: IssueRef = {
    owner: card.repo.owner,
    repo: card.repo.name,
    number: card.number,
  };
  const children = card.children ?? [];
  const { total, completed } = card.subIssues;
  const { parent } = card;

  return (
    <Collapsible
      onOpenChange={(open) => actions.setExpanded(card.id, open)}
      open={children.length > 0 && actions.isExpanded(card.id)}
    >
      <Card
        className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-issue-id={card.id}
        onClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("a, button") === null
          ) {
            actions.onOpen(ref);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) {
            event.preventDefault();
            actions.onOpen(ref);
          }
        }}
        tabIndex={0}
      >
        <CardPanel className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-muted-foreground text-xs">
              {repo} <span className="tabular-nums">#{card.number}</span>
            </p>
            <Button
              aria-label={`Open ${repo}#${card.number} on GitHub`}
              render={<a href={card.url} rel="noreferrer" target="_blank" />}
              size="icon-xs"
              variant="ghost"
            >
              <ExternalLinkIcon aria-hidden="true" />
            </Button>
          </div>
          <p className="break-words font-medium text-sm">{card.title}</p>
          {
            // Only an expanded-mode card names its parent: the server leaves
            // `children` off there, while collapsed mode nests sub-issues
            // under their parent card (SPEC FR-31, FR-32).
            card.children !== undefined || parent === null ? null : (
              <Button
                className="-mx-2 h-4 max-w-full justify-start px-2 font-normal text-muted-foreground text-xs"
                onClick={() => actions.onOpen(parent)}
                size="xs"
                title={`Open the parent ${parent.owner}/${parent.repo}#${String(parent.number)}`}
                variant="link"
              >
                <span aria-hidden="true">↳</span>
                <span className="truncate">
                  {parent.owner}/{parent.repo}#{parent.number}
                </span>
              </Button>
            )
          }
          {card.columnName === undefined &&
          card.type === null &&
          !card.isBlocked &&
          card.labels.length === 0 ? null : (
            <div className="flex flex-wrap gap-1">
              {card.columnName === undefined ? null : (
                <Badge variant="outline">{card.columnName}</Badge>
              )}
              {card.type === null ? null : (
                <Badge style={issueTypeColors(card.type.color)}>
                  {card.type.name}
                </Badge>
              )}
              {card.isBlocked ? (
                <Badge variant="destructive">blocked</Badge>
              ) : null}
              {card.labels.map((label) => (
                <Badge key={label.name} style={labelColors(label.color)}>
                  {label.name}
                </Badge>
              ))}
            </div>
          )}
          {card.assignees.length === 0 ? null : (
            <div className="flex -space-x-1.5">
              {card.assignees.map((assignee) => (
                <Avatar
                  className="size-5 ring-2 ring-background"
                  key={assignee.login}
                  title={assignee.login}
                >
                  <AvatarImage alt={assignee.login} src={assignee.avatarUrl} />
                  <AvatarFallback>
                    {assignee.login.slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>
          )}
          {total === 0 ? null : children.length > 0 ? (
            <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-md text-muted-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRightIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90"
              />
              <span className="sr-only">Sub-issues</span>
              <Progress
                aria-label="Sub-issues completed"
                max={total}
                value={completed}
              />
              <span className="tabular-nums">
                {completed}/{total}
              </span>
            </CollapsibleTrigger>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Progress
                aria-label="Sub-issues completed"
                max={total}
                value={completed}
              />
              <span className="tabular-nums">
                {completed}/{total}
              </span>
            </div>
          )}
        </CardPanel>
      </Card>
      {children.length === 0 ? null : (
        <CollapsiblePanel>
          <div className="mt-2 ml-3 flex flex-col gap-2 border-l pl-3">
            {children.map((child) => (
              <BoardCard actions={actions} card={child} key={child.id} />
            ))}
          </div>
        </CollapsiblePanel>
      )}
    </Collapsible>
  );
}
