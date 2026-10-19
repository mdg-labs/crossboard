import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SORT_ITEMS, type Sort } from "@/lib/issues";
import { ApiError, createView, renameView, type SavedView } from "@/lib/views";

const NAME_MAX = 100;

export type ViewNameTarget =
  | { mode: "save"; filter: string; sort: Sort }
  | { mode: "rename"; view: SavedView };

const sortLabel = (sort: Sort) =>
  SORT_ITEMS.find((item) => item.value === sort)?.label ?? sort;

/**
 * Names the current filter and sort, or renames a saved view (SPEC FR-22).
 * The form is mounted only while the dialog is open, so it starts clean every
 * time.
 */
export function ViewNameDialog({
  target,
  onClose,
  onDone,
}: {
  target: ViewNameTarget | null;
  onClose: () => void;
  onDone: (view: SavedView) => void;
}): React.ReactElement {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={target !== null}
    >
      <DialogPopup>
        {target === null ? null : (
          <ViewNameForm onDone={onDone} target={target} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ViewNameForm({
  target,
  onDone,
}: {
  target: ViewNameTarget;
  onDone: (view: SavedView) => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [nameError, setNameError] = useState<string | null>(null);
  const [otherError, setOtherError] = useState<string | null>(null);
  const saving = target.mode === "save";

  const mutation = useMutation({
    mutationFn: (name: string) =>
      target.mode === "save"
        ? createView({
            name,
            filter: target.filter,
            sort: target.sort,
          })
        : renameView(target.view.id, name),
    onSuccess: async (view) => {
      await queryClient.invalidateQueries({ queryKey: ["views"] });
      onDone(view);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setNameError("You already have a view with this name.");
      } else {
        setOtherError(
          error instanceof Error ? error.message : "Could not save the view.",
        );
      }
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{saving ? "Save view" : "Rename view"}</DialogTitle>
        <DialogDescription>
          {saving ? (
            <>
              Saves{" "}
              {target.filter === "" ? (
                "the default filter"
              ) : (
                <code className="break-all">{target.filter}</code>
              )}
              , sorted by {sortLabel(target.sort).toLowerCase()}.
            </>
          ) : (
            <>
              Give &ldquo;{target.view.name}&rdquo; a new name. Its filter and
              sort stay as they are.
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      <Form
        className="contents"
        onFormSubmit={(values) => {
          const name = String(values.name ?? "").trim();
          setOtherError(null);
          if (name === "" || name.length > NAME_MAX) {
            setNameError(`Enter a name of 1 to ${NAME_MAX} characters.`);
            return;
          }
          setNameError(null);
          mutation.mutate(name);
        }}
      >
        <DialogPanel className="flex flex-col gap-4">
          <Field invalid={nameError !== null} name="name">
            <FieldLabel>Name</FieldLabel>
            <Input
              autoComplete="off"
              autoFocus
              defaultValue={target.mode === "rename" ? target.view.name : ""}
              onChange={() => setNameError(null)}
              type="text"
            />
            <FieldError match={nameError !== null}>{nameError}</FieldError>
          </Field>
          {otherError === null ? null : (
            <Alert variant="error">
              <AlertDescription>{otherError}</AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            Cancel
          </DialogClose>
          <Button loading={mutation.isPending} type="submit">
            {saving ? "Save view" : "Rename"}
          </Button>
        </DialogFooter>
      </Form>
    </>
  );
}
