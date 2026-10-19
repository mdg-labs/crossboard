import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  checkDraft,
  moveColumn,
  newColumn,
  toInput,
  type BoardDraft,
  type ColumnDraft,
} from "@/components/board-form/board-draft";
import { DeleteBoardDialog } from "@/components/board-form/delete-board-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  BOARD_COLUMNS_MAX,
  boardQuery,
  createBoard,
  SUB_ISSUE_MODE_ITEMS,
  updateBoard,
  type Board,
} from "@/lib/boards";
import { SORT_ITEMS } from "@/lib/issues";

/**
 * The board form (SPEC FR-37): every board field and the column list, with
 * the filters checked by the shared parser as they are typed (FR-29). It is
 * mounted with the board it edits, or without one for a new board, and starts
 * from `initial`.
 */
export function BoardForm({
  board,
  initial,
}: {
  board: Pick<Board, "id" | "name"> | null;
  initial: BoardDraft;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const problems = useMemo(() => checkDraft(draft), [draft]);

  const mutation = useMutation({
    mutationFn: () =>
      board === null
        ? createBoard(toInput(draft))
        : updateBoard(board.id, toInput(draft)),
    onSuccess: async (saved) => {
      queryClient.setQueryData(boardQuery(saved.id).queryKey, saved);
      await queryClient.invalidateQueries({
        queryKey: ["boards"],
        exact: true,
      });
      router.history.push(`/b/${String(saved.id)}`);
    },
    onError: (failure) =>
      setSaveError(
        failure instanceof Error
          ? failure.message
          : "Could not save the board.",
      ),
  });

  const patch = (next: Partial<BoardDraft>) =>
    setDraft((current) => ({ ...current, ...next }));
  const patchColumn = (key: number, next: Partial<ColumnDraft>) =>
    setDraft((current) => ({
      ...current,
      columns: current.columns.map((column) =>
        column.key === key ? { ...column, ...next } : column,
      ),
    }));

  const nameProblem = submitted ? problems.name : null;

  return (
    <>
      <Form
        className="flex flex-col gap-6"
        onFormSubmit={() => {
          setSubmitted(true);
          setSaveError(null);
          if (problems.valid) {
            mutation.mutate();
          }
        }}
      >
        <Field invalid={nameProblem !== null} name="name">
          <FieldLabel>Name</FieldLabel>
          <Input
            autoComplete="off"
            autoFocus
            onChange={(event) => patch({ name: event.target.value })}
            type="text"
            value={draft.name}
          />
          <FieldError match={nameProblem !== null}>{nameProblem}</FieldError>
        </Field>

        <Field invalid={problems.baseFilter !== null} name="baseFilter">
          <FieldLabel>Base filter</FieldLabel>
          <Input
            autoComplete="off"
            onChange={(event) => patch({ baseFilter: event.target.value })}
            spellCheck={false}
            type="text"
            value={draft.baseFilter}
          />
          <FieldDescription>
            Every column starts from the issues this filter matches. Leave it
            empty for all open issues.
          </FieldDescription>
          <FieldError match={problems.baseFilter !== null}>
            {problems.baseFilter}
          </FieldError>
        </Field>

        <div className="grid gap-6 sm:grid-cols-2">
          <Field name="sort">
            <FieldLabel>Sort</FieldLabel>
            <Select
              items={SORT_ITEMS}
              onValueChange={(value) => {
                if (value !== null) {
                  patch({ sort: value });
                }
              }}
              value={draft.sort}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SORT_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field name="subIssueMode">
            <FieldLabel>Sub-issues</FieldLabel>
            <Select
              items={SUB_ISSUE_MODE_ITEMS}
              onValueChange={(value) => {
                if (value !== null) {
                  patch({ subIssueMode: value });
                }
              }}
              value={draft.subIssueMode}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SUB_ISSUE_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>
              Collapsed folds sub-issues into their parent&rsquo;s card.
            </FieldDescription>
          </Field>
        </div>

        <Field name="showOther">
          <FieldLabel>
            <Switch
              checked={draft.showOther}
              onCheckedChange={(checked) => patch({ showOther: checked })}
            />
            Show an Other column
          </FieldLabel>
          <FieldDescription>
            Collects the issues that match the base filter but no column.
          </FieldDescription>
        </Field>

        <Fieldset className="flex flex-col gap-3">
          <FieldsetLegend>Columns</FieldsetLegend>
          <ol className="flex flex-col gap-3">
            {draft.columns.map((column, index) => {
              const own = problems.columns[index];
              const nameError = submitted ? (own?.name ?? null) : null;
              const filterError = own?.filter ?? null;
              const position = String(index + 1);
              return (
                <li
                  className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-start"
                  key={column.key}
                >
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                    <Field
                      invalid={nameError !== null}
                      name={`columns.${position}.name`}
                    >
                      <FieldLabel>Column {position} name</FieldLabel>
                      <Input
                        autoComplete="off"
                        onChange={(event) =>
                          patchColumn(column.key, { name: event.target.value })
                        }
                        type="text"
                        value={column.name}
                      />
                      <FieldError match={nameError !== null}>
                        {nameError}
                      </FieldError>
                    </Field>
                    <Field
                      invalid={filterError !== null}
                      name={`columns.${position}.filter`}
                    >
                      <FieldLabel>Column {position} filter</FieldLabel>
                      <Input
                        autoComplete="off"
                        onChange={(event) =>
                          patchColumn(column.key, {
                            filter: event.target.value,
                          })
                        }
                        spellCheck={false}
                        type="text"
                        value={column.filter}
                      />
                      <FieldError match={filterError !== null}>
                        {filterError}
                      </FieldError>
                    </Field>
                  </div>
                  <div className="flex gap-1 sm:pt-6">
                    <Button
                      aria-label={`Move column ${position} up`}
                      disabled={index === 0}
                      onClick={() =>
                        patch({ columns: moveColumn(draft.columns, index, -1) })
                      }
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={`Move column ${position} down`}
                      disabled={index === draft.columns.length - 1}
                      onClick={() =>
                        patch({ columns: moveColumn(draft.columns, index, 1) })
                      }
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={`Remove column ${position}`}
                      disabled={draft.columns.length === 1}
                      onClick={() =>
                        patch({
                          columns: draft.columns.filter(
                            (entry) => entry.key !== column.key,
                          ),
                        })
                      }
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <Button
            className="self-start"
            disabled={draft.columns.length >= BOARD_COLUMNS_MAX}
            onClick={() => patch({ columns: [...draft.columns, newColumn()] })}
            type="button"
            variant="outline"
          >
            <PlusIcon aria-hidden="true" />
            Add column
          </Button>
        </Fieldset>

        {saveError === null ? null : (
          <Alert variant="error">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button loading={mutation.isPending} type="submit">
            {board === null ? "Create board" : "Save board"}
          </Button>
          <Link className={buttonVariants({ variant: "ghost" })} to="/">
            Cancel
          </Link>
          {board === null ? null : (
            <Button
              className="ms-auto"
              onClick={() => setDeleting(true)}
              type="button"
              variant="destructive-outline"
            >
              Delete board
            </Button>
          )}
        </div>
      </Form>
      {board === null ? null : (
        <DeleteBoardDialog
          board={board}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            queryClient.removeQueries({
              queryKey: boardQuery(board.id).queryKey,
              exact: true,
            });
            await queryClient.invalidateQueries({
              queryKey: ["boards"],
              exact: true,
            });
            void navigate({ to: "/" });
          }}
          open={deleting}
        />
      )}
    </>
  );
}
