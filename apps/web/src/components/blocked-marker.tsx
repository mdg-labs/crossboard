import { BanIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { IssueItem } from "@/lib/issues";

/**
 * The marker of a blocked issue on a list row or a board card (SPEC FR-26):
 * shown exactly when the issue is blocked (`isBlocked`, FR-25), with the
 * number of blockers FR-12 counts (open readable ones plus not-accessible
 * ones) in its tooltip.
 */
export function BlockedMarker({
  issue,
}: {
  issue: Pick<IssueItem, "isBlocked" | "blockedBy">;
}): React.ReactElement | null {
  if (!issue.isBlocked) {
    return null;
  }
  const label = `Blocked by ${String(issue.blockedBy.open + issue.blockedBy.notAccessible)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="inline-flex shrink-0 text-destructive-foreground"
            data-slot="blocked-marker"
            role="img"
          />
        }
      >
        <BanIcon aria-hidden="true" className="size-4" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
