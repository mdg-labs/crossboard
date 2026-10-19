import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { IssueRow, ROW_HEIGHT } from "@/components/issue-list/issue-row";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { IssueItem } from "@/lib/issues";

const HEADER_HEIGHT = 40;
const OVERSCAN = 10;
/** Loads the next page when the rendered rows come this close to the end. */
const LOAD_MARGIN = 20;

const COLUMNS = [
  { key: "repo", label: "Repository", className: "w-40" },
  { key: "number", label: "Issue", className: "w-16" },
  { key: "title", label: "Title", className: "w-auto" },
  { key: "type", label: "Type", className: "w-24" },
  { key: "labels", label: "Labels", className: "w-48" },
  { key: "assignees", label: "Assignees", className: "w-28" },
  { key: "milestone", label: "Milestone", className: "w-28" },
  { key: "dependencies", label: "Dependencies", className: "w-44" },
  { key: "subissues", label: "Sub-issues", className: "w-32" },
  { key: "updated", label: "Updated", className: "w-28" },
  {
    key: "open",
    label: <span className="sr-only">Open on GitHub</span>,
    className: "w-12",
  },
];

export function IssueTable({
  items,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: IssueItem[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}): React.ReactElement {
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

  return (
    <Table
      className="min-w-[1500px] table-fixed border-separate border-spacing-0"
      render={<div className="min-h-0 flex-1 overflow-auto" ref={scrollRef} />}
    >
      <TableHeader className="sticky top-0 z-10 bg-background [&_th]:border-b">
        <TableRow className="border-b-0">
          {COLUMNS.map((column) => (
            <TableHead className={column.className} key={column.key}>
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
          const issue = items[row.index];
          return issue === undefined ? null : (
            <IssueRow issue={issue} key={issue.id} />
          );
        })}
        {paddingBottom > 0 ? (
          <tr aria-hidden="true" style={{ height: paddingBottom }} />
        ) : null}
      </TableBody>
    </Table>
  );
}
