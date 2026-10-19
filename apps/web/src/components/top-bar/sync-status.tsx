import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { RelativeTime } from "@/components/issue-list/relative-time";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsoluteTime } from "@/lib/time";
import { refreshSync, syncQuery } from "@/lib/sync";

/** "Synced <time>" and the Refresh button (SPEC FR-45). */
export function SyncStatus(): React.ReactElement {
  const queryClient = useQueryClient();
  const sync = useQuery(syncQuery);
  const refresh = useMutation({
    mutationFn: refreshSync,
    onSuccess: () => {
      toastManager.add({
        type: "success",
        title: "Refresh queued",
        description: "Your repositories are being checked for changes.",
      });
    },
    onError: (failure) =>
      toastManager.add({
        type: "error",
        title: "Could not refresh",
        description:
          failure instanceof Error
            ? failure.message
            : "Check your connection and try again.",
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sync"] }),
  });

  const syncedAt = sync.data?.syncedAt ?? null;

  return (
    <>
      <span
        className="text-muted-foreground text-sm"
        role="status"
        aria-live="polite"
      >
        {sync.isPending ? (
          "Checking sync…"
        ) : sync.isError ? (
          "Sync status unavailable"
        ) : syncedAt === null ? (
          "Not synced yet"
        ) : (
          <>
            Synced <RelativeTime timestamp={syncedAt} />
          </>
        )}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <ToolbarButton
              render={
                <Button
                  aria-label="Refresh"
                  loading={refresh.isPending}
                  onClick={() => refresh.mutate()}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <RefreshCwIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup>
          {syncedAt === null
            ? "Refresh"
            : `Refresh · last synced ${formatAbsoluteTime(syncedAt)}`}
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
