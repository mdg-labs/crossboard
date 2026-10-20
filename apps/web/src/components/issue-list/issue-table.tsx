import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { DetailDrawer } from "@/components/detail/detail-drawer";
import { isShortcut } from "@/components/filter-bar/keyboard";
import { useExpandedRows } from "@/components/issue-list/expanded-rows";
import { IssueRow, ROW_HEIGHT } from "@/components/issue-list/issue-row";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { IssueRef } from "@/lib/issue-detail";
import { visibleRows, type IssueItem } from "@/lib/issues";

const refOf = (issue: IssueItem): IssueRef => ({
  owner: issue.repo.owner,
  repo: issue.repo.name,
  number: issue.number,
});

const HEADER_HEIGHT = 40;
const OVERSCAN = 10;
/** Loads the next page when the rendered rows come this close to the end. */
const LOAD_MARGIN = 20;

/** Widths in px; the title takes what the table has beyond `TITLE_MIN_WIDTH`. */
const COLUMNS = [
  { key: "repo", label: "Repository", width: 160 },
  { key: "number", label: "Issue", width: 64 },
  { key: "title", label: "Title", width: null },
  { key: "type", label: "Type", width: 96 },
  { key: "updated", label: "Updated", width: 112 },
  {
    key: "open",
    label: <span className="sr-only">Open on GitHub</span>,
    width: 48,
  },
  { key: "labels", label: "Labels", width: 192 },
  { key: "assignees", label: "Assignees", width: 112 },
  { key: "milestone", label: "Milestone", width: 112 },
  { key: "dependencies", label: "Dependencies", width: 176 },
  { key: "subissues", label: "Sub-issues", width: 128 },
];

/** The columns that lead the row and must fit the narrowest desktop viewport (SPEC FR-12, D-13). */
const LEADING_COLUMNS = 6;
export const TITLE_MIN_WIDTH = 288;
export const LEADING_WIDTH =
  COLUMNS.slice(0, LEADING_COLUMNS).reduce(
    (sum, column) => sum + (column.width ?? 0),
    0,
  ) + TITLE_MIN_WIDTH;
const TABLE_MIN_WIDTH =
  COLUMNS.reduce((sum, column) => sum + (column.width ?? 0), 0) +
  TITLE_MIN_WIDTH;

/**
 * The virtualized list (SPEC FR-11). In nesting mode (`nest`) `items` are the
 * top-level issues and the rows are flattened from the ones the viewer
 * expanded (FR-12); `j`/`k`, `Enter` and `o` work over those visible rows.
 */
export function IssueTable({
  items: topLevel,
  nest,
  hasMore,
  loadingMore,
  onLoadMore,
  onFilter,
}: {
  items: IssueItem[];
  nest: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onFilter: (qualifier: string) => void;
}): React.ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<IssueRef | null>(null);
  const { isExpanded, setExpanded } = useExpandedRows();
  const lines = visibleRows(topLevel, isExpanded);
  const items = lines.map((line) => line.issue);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollPaddingStart: HEADER_HEIGHT,
    getItemKey: (index) => items[index]?.id ?? index,
  });

  const rows = virtualizer.getVirtualItems();
  const first = rows[0];
  const last = rows[rows.length - 1];
  const paddingTop = first?.start ?? 0;
  const paddingBottom =
    last === undefined ? 0 : virtualizer.getTotalSize() - last.end;
  const lastIndex = last?.index ?? -1;

  useEffect(() => {
    if (hasMore && !loadingMore && lastIndex >= items.length - LOAD_MARGIN) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, lastIndex, items.length, onLoadMore]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isShortcut(event)) {
        return;
      }
      const current = items.findIndex((issue) => issue.id === selectedId);
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const next = Math.min(
          Math.max(current + (event.key === "j" ? 1 : -1), 0),
          items.length - 1,
        );
        const issue = items[next];
        setSelectedId(issue?.id ?? null);
        if (issue !== undefined) {
          setPanel((shown) => (shown === null ? null : refOf(issue)));
        }
        virtualizer.scrollToIndex(next);
      } else if (event.key === "o" && current >= 0) {
        event.preventDefault();
        window.open(items[current]?.url, "_blank", "noopener,noreferrer");
      } else if (
        event.key === "Enter" &&
        current >= 0 &&
        !(
          event.target instanceof Element &&
          event.target.closest("a, button, summary") !== null
        )
      ) {
        event.preventDefault();
        const issue = items[current];
        if (issue !== undefined) {
          setPanel(refOf(issue));
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [items, selectedId, virtualizer]);

  const openIssue = (issue: IssueItem) => {
    setSelectedId(issue.id);
    setPanel(refOf(issue));
  };

  return (
    <>
      <Table
        className="table-fixed border-separate border-spacing-0"
        style={{ minWidth: TABLE_MIN_WIDTH }}
        render={
          <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef} />
        }
      >
        <TableHeader className="sticky top-0 z-10 bg-background [&_th]:border-b">
          <TableRow className="border-b-0">
            {COLUMNS.map((column) => (
              <TableHead
                key={column.key}
                style={
                  column.width === null ? undefined : { width: column.width }
                }
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {paddingTop > 0 ? (
            <tr aria-hidden="true" style={{ height: paddingTop }} />
          ) : null}
          {rows.map((row) => {
            const line = lines[row.index];
            return line === undefined ? null : (
              <IssueRow
                issue={line.issue}
                key={line.issue.id}
                nesting={
                  nest
                    ? {
                        depth: line.depth,
                        under: line.under,
                        expandable: line.expandable,
                        expanded: line.expanded,
                        onToggle: (open) => setExpanded(line.issue.id, open),
                      }
                    : undefined
                }
                onFilter={onFilter}
                onOpen={openIssue}
                onOpenRef={setPanel}
                selected={line.issue.id === selectedId}
              />
            );
          })}
          {paddingBottom > 0 ? (
            <tr aria-hidden="true" style={{ height: paddingBottom }} />
          ) : null}
        </TableBody>
      </Table>
      <DetailDrawer
        issue={panel}
        onClose={() => setPanel(null)}
        onOpenIssue={setPanel}
      />
    </>
  );
}
