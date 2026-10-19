import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { BoardColumn } from "@/components/board/board-column";
import { useExpandedCards } from "@/components/board/expanded-cards";
import { RepoPicker } from "@/components/board/repo-picker";
import {
  canPickRepos,
  pickedRepos,
  withPickedRepos,
} from "@/components/board/repo-term";
import { DetailDrawer } from "@/components/detail/detail-drawer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { boardCardsQuery, parseBoardSearch } from "@/lib/board-cards";
import { boardQuery } from "@/lib/boards";
import type { IssueRef } from "@/lib/issue-detail";
import { ApiError } from "@/lib/views";

const SKELETON_COLUMNS = 3;
const SKELETON_CARDS = 4;

const notFound = (error: Error): boolean =>
  error instanceof ApiError && error.status === 404;

const positiveInteger = (raw: string | undefined): number | null =>
  raw !== undefined && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="p-4">
      <Alert variant="error">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{children}</AlertDescription>
      </Alert>
    </div>
  );
}

const BoardNotFound = (): React.ReactElement => (
  <Notice title="Board not found">
    <p>This board does not exist, or it is not yours.</p>
  </Notice>
);

function BoardPage({ id, q }: { id: number; q: string }): React.ReactElement {
  const navigate = useNavigate();
  const [panel, setPanel] = useState<IssueRef | null>(null);
  const { isExpanded, setExpanded } = useExpandedCards(id);
  const board = useQuery({ ...boardQuery(id), refetchOnWindowFocus: false });
  const cards = useQuery({
    ...boardCardsQuery(id, q),
    placeholderData: keepPreviousData,
  });

  if (
    (board.isError && notFound(board.error)) ||
    (cards.isError && notFound(cards.error))
  ) {
    return <BoardNotFound />;
  }

  const actions = { onOpen: setPanel, isExpanded, setExpanded };
  const picked = pickedRepos(q);
  const columns = cards.data?.columns ?? [];
  const other = cards.data?.other;
  const total =
    columns.reduce((sum, column) => sum + column.count, 0) +
    (other?.count ?? 0);

  let body: React.ReactElement;
  if (cards.isPending) {
    body = (
      <div
        aria-busy="true"
        aria-label="Loading board"
        className="flex min-h-0 flex-1 gap-3 p-4"
        role="status"
      >
        {Array.from({ length: SKELETON_COLUMNS }, (_, column) => (
          <div className="flex w-80 shrink-0 flex-col gap-2" key={column}>
            {Array.from({ length: SKELETON_CARDS }, (_, card) => (
              <Skeleton className="h-24 w-full" key={card} />
            ))}
          </div>
        ))}
      </div>
    );
  } else if (cards.data === undefined) {
    body = (
      <Notice title="Could not load the board">
        <p>{cards.error?.message ?? "Check your connection."}</p>
        <Button
          className="self-start"
          loading={cards.isFetching}
          onClick={() => void cards.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </Notice>
    );
  } else if (total === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No open issues match this board</EmptyTitle>
          <EmptyDescription>
            {q === ""
              ? "Issues appear here once they match the board's filters."
              : "Try a different filter or repository."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {columns.map((column) => (
          <BoardColumn
            actions={actions}
            cards={column.cards}
            count={column.count}
            key={column.id}
            name={column.name}
          />
        ))}
        {other === undefined ? null : (
          <BoardColumn
            actions={actions}
            cards={other.cards}
            count={other.count}
            name="Other"
          />
        )}
      </div>
    );
  }

  return (
    <section
      aria-label={board.data?.name ?? "Board"}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-4 border-b px-4 py-2">
        <h1 className="min-w-0 truncate font-semibold text-lg">
          {board.data?.name ?? "Board"}
        </h1>
        <RepoPicker
          disabled={!canPickRepos(q)}
          onChange={(repos) => {
            const next = withPickedRepos(q, repos);
            if (next !== null) {
              void navigate({
                to: "/b/$boardId",
                params: { boardId: String(id) },
                search: next === "" ? {} : { q: next },
              });
            }
          }}
          picked={picked}
        />
        <Link
          className={buttonVariants({
            className: "ms-auto",
            size: "sm",
            variant: "ghost",
          })}
          params={{ boardId: String(id) }}
          to="/b/$boardId/edit"
        >
          <PencilIcon aria-hidden="true" />
          Edit board
        </Link>
      </div>
      {body}
      <DetailDrawer
        issue={panel}
        onClose={() => setPanel(null)}
        onOpenIssue={setPanel}
      />
    </section>
  );
}

/** A board's columns and cards, `/b/:boardId` (SPEC FR-30 to FR-34, FR-38). */
export function BoardRoute(): React.ReactElement {
  const params = useParams({ strict: false });
  const id = positiveInteger(params.boardId);
  const q = parseBoardSearch(useSearch({ strict: false })).q ?? "";

  return id === null ? <BoardNotFound /> : <BoardPage id={id} key={id} q={q} />;
}
