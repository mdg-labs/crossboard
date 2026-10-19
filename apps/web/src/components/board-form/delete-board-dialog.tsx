import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteBoard } from "@/lib/boards";

/** Asks before a board is deleted (SPEC FR-35, §10.1). */
export function DeleteBoardDialog({
  board,
  open,
  onClose,
  onDeleted,
}: {
  board: { id: number; name: string };
  open: boolean;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}): React.ReactElement {
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <AlertDialogPopup>
        {open ? (
          <DeleteBoardContent board={board} onDeleted={onDeleted} />
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function DeleteBoardContent({
  board,
  onDeleted,
}: {
  board: { id: number; name: string };
  onDeleted: () => void | Promise<void>;
}): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => deleteBoard(board.id),
    onSuccess: () => onDeleted(),
    onError: (failure) =>
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not delete the board.",
      ),
  });

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete this board?</AlertDialogTitle>
        <AlertDialogDescription>
          &ldquo;{board.name}&rdquo; and its columns will be deleted. The issues
          it shows stay where they are.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error === null ? null : (
        <div className="px-6 pb-4">
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="ghost" />}>
          Cancel
        </AlertDialogClose>
        <Button
          loading={mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
          type="button"
          variant="destructive"
        >
          Delete board
        </Button>
      </AlertDialogFooter>
    </>
  );
}
