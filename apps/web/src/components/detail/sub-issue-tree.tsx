import { ChevronRightIcon } from "lucide-react";
import { IssueLink } from "@/components/detail/issue-link";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@/components/ui/progress";
import { type IssueRef, type SubIssueNode, refLabel } from "@/lib/issue-detail";
import { cn } from "@/lib/utils";

/**
 * A list of sub-issues (SPEC FR-40): each row shows its state, ref, title and
 * `completed/total` progress; a synced row with synced sub-issues expands to
 * them, at any depth. Which rows are open is local to the list and not kept.
 */
export function SubIssueList({
  label,
  nodes,
  notAccessible,
  onOpenIssue,
  className,
  children,
}: {
  label: string;
  nodes: SubIssueNode[];
  notAccessible: number;
  onOpenIssue: (issue: IssueRef) => void;
  className?: string;
  /** Extra rows after the sub-issues. */
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <ul aria-label={label} className={cn("flex flex-col gap-1.5", className)}>
      {nodes.map((node) => (
        <SubIssueRow
          key={refLabel(node)}
          node={node}
          onOpenIssue={onOpenIssue}
        />
      ))}
      {notAccessible > 0 ? (
        <li className="text-muted-foreground">
          +{notAccessible} not accessible
        </li>
      ) : null}
      {children}
    </ul>
  );
}

function SubIssueSummary({
  node,
  onOpenIssue,
  toggle,
}: {
  node: SubIssueNode;
  onOpenIssue: (issue: IssueRef) => void;
  toggle: React.ReactNode;
}): React.ReactElement {
  const progress = node.subIssues;
  return (
    <div className="flex items-center gap-2">
      {toggle}
      <Badge
        size="sm"
        variant={node.state === "OPEN" ? "success" : "secondary"}
      >
        {node.state === "OPEN" ? "Open" : "Closed"}
      </Badge>
      <IssueLink
        className="shrink-0 text-muted-foreground tabular-nums hover:underline"
        issue={node}
        onOpenIssue={onOpenIssue}
        synced={node.synced}
        url={node.url}
      >
        {refLabel(node)}
      </IssueLink>
      <span className="min-w-0 flex-1 truncate" title={node.title}>
        {node.title}
      </span>
      {progress !== null && progress.total > 0 ? (
        <Progress
          aria-label={`${String(progress.completed)} of ${String(progress.total)} completed`}
          className="w-24 shrink-0 flex-row items-center gap-2"
          max={progress.total}
          value={progress.completed}
        >
          <ProgressTrack className="flex-1">
            <ProgressIndicator />
          </ProgressTrack>
          <span className="text-muted-foreground text-xs tabular-nums">
            {progress.completed}/{progress.total}
          </span>
        </Progress>
      ) : null}
    </div>
  );
}

function SubIssueRow({
  node,
  onOpenIssue,
}: {
  node: SubIssueNode;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  const closed = node.state === "CLOSED";
  const className = cn(closed && "text-muted-foreground line-through");
  const expandable =
    node.synced && (node.children.length > 0 || node.notAccessible > 0);

  if (!expandable) {
    return (
      <li className={className}>
        <SubIssueSummary
          node={node}
          onOpenIssue={onOpenIssue}
          toggle={<span aria-hidden="true" className="size-4 shrink-0" />}
        />
      </li>
    );
  }
  return (
    <li className={className}>
      <Collapsible>
        <SubIssueSummary
          node={node}
          onOpenIssue={onOpenIssue}
          toggle={
            <CollapsibleTrigger
              aria-label={`Sub-issues of ${refLabel(node)}`}
              className="group flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRightIcon
                aria-hidden="true"
                className="size-4 transition-transform group-data-panel-open:rotate-90"
              />
            </CollapsibleTrigger>
          }
        />
        <CollapsiblePanel>
          <SubIssueList
            className="mt-1.5 ms-2 border-s ps-4"
            label={`Sub-issues of ${refLabel(node)}`}
            nodes={node.children}
            notAccessible={node.notAccessible}
            onOpenIssue={onOpenIssue}
          />
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}
