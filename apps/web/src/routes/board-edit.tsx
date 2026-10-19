import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { BoardForm } from "@/components/board-form/board-form";
import { ExportBoardButton } from "@/components/board-form/export-board-button";
import {
  draftFromBoard,
  emptyDraft,
} from "@/components/board-form/board-draft";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { boardQuery } from "@/lib/boards";
import { ApiError } from "@/lib/views";

const notFound = (error: Error): boolean =>
  error instanceof ApiError && error.status === 404;

function Page({
  title,
  actions = null,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <Link
        className={buttonVariants({
          className: "self-start",
          size: "sm",
          variant: "ghost",
        })}
        to="/"
      >
        <ArrowLeftIcon aria-hidden="true" />
        All issues
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-xl">{title}</h1>
        {actions}
      </div>
      {children}
    </div>
  );
}

/** The form for a new board, `/b/new` (SPEC FR-37, FR-38). */
export function BoardNewRoute(): React.ReactElement {
  return (
    <Page title="New board">
      <BoardForm board={null} initial={emptyDraft()} />
    </Page>
  );
}

const positiveInteger = (raw: string | undefined): number | null =>
  raw !== undefined && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;

/** The form for an existing board, `/b/:boardId/edit` (SPEC FR-37, FR-38). */
export function BoardEditRoute(): React.ReactElement {
  const params = useParams({ strict: false });
  const id = positiveInteger(params.boardId);
  const board = useQuery({
    ...boardQuery(id ?? 0),
    enabled: id !== null,
    refetchOnWindowFocus: false,
  });

  if (id === null || (board.isError && notFound(board.error))) {
    return (
      <Page title="Edit board">
        <Alert variant="error">
          <AlertTitle>Board not found</AlertTitle>
          <AlertDescription>
            <p>This board does not exist, or it is not yours.</p>
          </AlertDescription>
        </Alert>
      </Page>
    );
  }
  if (board.isError) {
    return (
      <Page title="Edit board">
        <Alert variant="error">
          <AlertTitle>Could not load the board</AlertTitle>
          <AlertDescription>
            <p>{board.error.message}</p>
          </AlertDescription>
        </Alert>
        <Button
          className="self-start"
          loading={board.isFetching}
          onClick={() => void board.refetch()}
          variant="outline"
        >
          Try again
        </Button>
      </Page>
    );
  }
  if (board.isPending) {
    return (
      <Page title="Edit board">
        <div
          aria-busy="true"
          aria-label="Loading board"
          className="flex flex-col gap-4"
          role="status"
        >
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Page>
    );
  }
  return (
    <Page
      actions={
        <ExportBoardButton
          board={{ id: board.data.id, name: board.data.name }}
        />
      }
      title="Edit board"
    >
      <BoardForm
        board={{ id: board.data.id, name: board.data.name }}
        initial={draftFromBoard(board.data)}
      />
    </Page>
  );
}
