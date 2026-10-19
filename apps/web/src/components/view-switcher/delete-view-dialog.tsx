import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { deleteView, type SavedView } from "@/lib/views";

/** Asks before a saved view is deleted (SPEC FR-22, §10.1). */
export function DeleteViewDialog({
  view,
  onClose,
  onDeleted,
}: {
  view: SavedView | null;
  onClose: () => void;
  onDeleted: (view: SavedView) => void;
}): React.ReactElement {
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={view !== null}
    >
      <AlertDialogPopup>
        {view === null ? null : (
          <DeleteViewContent onDeleted={onDeleted} view={view} />
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function DeleteViewContent({
  view,
  onDeleted,
}: {
  view: SavedView;
  onDeleted: (view: SavedView) => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => deleteView(view.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["views"] });
      onDeleted(view);
    },
    onError: (failure) =>
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not delete the view.",
      ),
  });

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete this view?</AlertDialogTitle>
        <AlertDialogDescription>
          &ldquo;{view.name}&rdquo; will be deleted. The issues it shows stay
          where they are.
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
          Delete view
        </Button>
      </AlertDialogFooter>
    </>
  );
}
