import { useMutation } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { downloadBoard } from "@/lib/board-transfer";
import type { Board } from "@/lib/boards";

/** Downloads the board as a JSON file (SPEC FR-36). */
export function ExportBoardButton({
  board,
}: {
  board: Pick<Board, "id" | "name">;
}): React.ReactElement {
  const mutation = useMutation({
    mutationFn: () => downloadBoard(board),
    onError: (failure) =>
      toastManager.add({
        type: "error",
        title: "Could not export the board",
        description:
          failure instanceof Error
            ? failure.message
            : "Check your connection and try again.",
      }),
  });
  return (
    <Button
      loading={mutation.isPending}
      onClick={() => mutation.mutate()}
      type="button"
      variant="outline"
    >
      <DownloadIcon aria-hidden="true" />
      Export
    </Button>
  );
}
