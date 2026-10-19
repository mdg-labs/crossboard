import { IssueLink } from "@/components/detail/issue-link";
import type { IssueRef, IssueRelation } from "@/lib/issue-detail";
import { cn } from "@/lib/utils";

/** The `blockedBy` / `blocking` list of a summary (SPEC FR-23, FR-24). */
export function RelationList({
  label,
  list,
  onOpenIssue,
}: {
  label: string;
  list: { notAccessible: number; items: IssueRelation[] };
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  return (
    <ul aria-label={label} className="flex flex-col gap-1.5 text-sm">
      {list.items.map((entry) => (
        <li
          className={cn(
            "flex items-baseline gap-2",
            entry.state === "CLOSED" && "text-muted-foreground line-through",
          )}
          key={`${entry.owner}/${entry.repo}#${String(entry.number)}`}
        >
          <IssueLink
            className="shrink-0 text-muted-foreground tabular-nums hover:underline"
            issue={entry}
            onOpenIssue={onOpenIssue}
            synced={entry.synced}
            url={entry.url}
          >
            {entry.owner}/{entry.repo}#{entry.number}
          </IssueLink>
          <span className="min-w-0 truncate" title={entry.title}>
            {entry.title}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {entry.state.toLowerCase()}
          </span>
        </li>
      ))}
      {list.notAccessible > 0 ? (
        <li className="text-muted-foreground">
          +{list.notAccessible} not accessible
        </li>
      ) : null}
      {list.items.length === 0 && list.notAccessible === 0 ? (
        <li className="text-muted-foreground">None</li>
      ) : null}
    </ul>
  );
}
