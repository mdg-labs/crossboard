import { useQuery } from "@tanstack/react-query";
import {
  useLocation,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { BookmarkIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { DeleteViewDialog } from "@/components/view-switcher/delete-view-dialog";
import {
  ViewNameDialog,
  type ViewNameTarget,
} from "@/components/view-switcher/view-name-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ToolbarButton } from "@/components/ui/toolbar";
import { boardsQuery } from "@/lib/boards";
import { DEFAULT_SORT, parseIndexSearch } from "@/lib/issues";
import { viewsQuery, type SavedView } from "@/lib/views";

/**
 * The view and board switcher of the top bar (SPEC FR-22, §10.1): opens a
 * saved view by setting `?q=` and `?sort=`, saves the current filter and sort
 * under a name, renames or deletes the view that is open, and lists the
 * boards to open, edit or add (FR-37, FR-38).
 */
export function ViewSwitcher(): React.ReactElement {
  const search = parseIndexSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const onBoardPath = /^\/b(\/|$)/.test(pathname);
  const openBoardId = /^\/b\/([1-9][0-9]*)(\/edit)?$/.exec(pathname)?.[1];
  const [opened, setOpened] = useState(false);
  const filter = (search.q ?? "").trim();
  const sort = search.sort ?? DEFAULT_SORT;
  const isDefault = filter === "" && sort === DEFAULT_SORT;
  // The views are only needed to open the menu or to name a filter that is set.
  const views = useQuery({
    ...viewsQuery,
    enabled: opened || (!isDefault && !onBoardPath),
  });
  const boards = useQuery({
    ...boardsQuery,
    enabled: opened || openBoardId !== undefined,
  });
  const openBoard =
    openBoardId === undefined
      ? null
      : (boards.data?.find((board) => String(board.id) === openBoardId) ??
        null);
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [naming, setNaming] = useState<ViewNameTarget | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);

  const matching = onBoardPath
    ? []
    : (views.data ?? []).filter(
        (view) => view.filter === filter && view.sort === sort,
      );
  const active =
    matching.find((view) => view.id === chosenId) ?? matching[0] ?? null;
  const label = onBoardPath
    ? (openBoard?.name ?? "Board")
    : (active?.name ??
      (isDefault
        ? "All issues"
        : views.isPending
          ? "Views"
          : "Unsaved filter"));

  const open = (next: { filter: string; sort: typeof sort }) =>
    void navigate({
      to: "/",
      search: {
        ...(next.filter === "" ? {} : { q: next.filter }),
        ...(next.sort === DEFAULT_SORT ? {} : { sort: next.sort }),
      },
    });

  const goTo = (path: string) => router.history.push(path);

  return (
    <>
      <Menu
        onOpenChange={(next) => {
          if (next) {
            setOpened(true);
          }
        }}
      >
        <MenuTrigger
          render={
            <ToolbarButton
              render={
                <Button
                  aria-label={`View: ${label}`}
                  size="sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <span className="max-w-48 truncate">{label}</span>
          <ChevronDownIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-56">
          <MenuItem onClick={() => open({ filter: "", sort: DEFAULT_SORT })}>
            All issues
          </MenuItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Saved views</MenuGroupLabel>
            {views.isPending ? (
              <div
                aria-busy="true"
                aria-label="Loading views"
                className="flex flex-col gap-2 px-2 py-1.5"
                role="status"
              >
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
            ) : views.isError ? (
              <>
                <Alert className="my-1" variant="error">
                  <AlertDescription>
                    Could not load your views.
                  </AlertDescription>
                </Alert>
                <MenuItem
                  closeOnClick={false}
                  onClick={() => void views.refetch()}
                >
                  Try again
                </MenuItem>
              </>
            ) : views.data.length === 0 ? (
              <Empty className="gap-0 px-3 py-3 md:py-3">
                <EmptyHeader>
                  <EmptyTitle className="text-base">
                    No saved views yet
                  </EmptyTitle>
                  <EmptyDescription>
                    Save the current filter and sort to reopen them from here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <MenuRadioGroup
                onValueChange={(value) => {
                  const view = views.data.find(
                    (entry) => String(entry.id) === value,
                  );
                  if (view !== undefined) {
                    setChosenId(view.id);
                    open({ filter: view.filter, sort: view.sort });
                  }
                }}
                value={active === null ? "" : String(active.id)}
              >
                {views.data.map((view) => (
                  <MenuRadioItem
                    closeOnClick
                    key={view.id}
                    value={String(view.id)}
                  >
                    {view.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            )}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Boards</MenuGroupLabel>
            {boards.isPending ? (
              <div
                aria-busy="true"
                aria-label="Loading boards"
                className="flex flex-col gap-2 px-2 py-1.5"
                role="status"
              >
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
            ) : boards.isError ? (
              <>
                <Alert className="my-1" variant="error">
                  <AlertDescription>
                    Could not load your boards.
                  </AlertDescription>
                </Alert>
                <MenuItem
                  closeOnClick={false}
                  onClick={() => void boards.refetch()}
                >
                  Try again
                </MenuItem>
              </>
            ) : (
              boards.data.map((board) => (
                <MenuItem
                  key={board.id}
                  onClick={() => goTo(`/b/${String(board.id)}`)}
                >
                  {board.name}
                </MenuItem>
              ))
            )}
            <MenuItem onClick={() => goTo("/b/new")}>
              <PlusIcon aria-hidden="true" />
              New board…
            </MenuItem>
            {openBoard === null ? null : (
              <MenuItem onClick={() => goTo(`/b/${String(openBoard.id)}/edit`)}>
                Edit “{openBoard.name}”…
              </MenuItem>
            )}
          </MenuGroup>
          {onBoardPath ? null : (
            <>
              <MenuSeparator />
              <MenuItem
                onClick={() => setNaming({ mode: "save", filter, sort })}
              >
                <BookmarkIcon aria-hidden="true" />
                Save current view…
              </MenuItem>
            </>
          )}
          {active === null ? null : (
            <>
              <MenuItem
                onClick={() => setNaming({ mode: "rename", view: active })}
              >
                Rename “{active.name}”…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onClick={() => setDeleting(active)}
                variant="destructive"
              >
                Delete “{active.name}”…
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
      <ViewNameDialog
        onClose={() => setNaming(null)}
        onDone={(view) => {
          setChosenId(view.id);
          setNaming(null);
        }}
        target={naming}
      />
      <DeleteViewDialog
        onClose={() => setDeleting(null)}
        onDeleted={() => setDeleting(null)}
        view={deleting}
      />
    </>
  );
}
