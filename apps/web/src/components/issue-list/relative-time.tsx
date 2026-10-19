import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

/** A time shown relative, with the absolute time in a tooltip (SPEC §10). */
export function RelativeTime({
  timestamp,
}: {
  timestamp: number;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={new Date(timestamp).toISOString()} />}
      >
        {formatRelativeTime(timestamp)}
      </TooltipTrigger>
      <TooltipPopup>{formatAbsoluteTime(timestamp)}</TooltipPopup>
    </Tooltip>
  );
}
