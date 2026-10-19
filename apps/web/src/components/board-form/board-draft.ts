import { parse } from "@crossboard/query";
import { DEFAULT_SORT, type Sort } from "@/lib/issues";
import {
  BOARD_NAME_MAX,
  type Board,
  type BoardInput,
  type SubIssueMode,
} from "@/lib/boards";

export interface ColumnDraft {
  /** Identifies the row across moves and removals; the server never sees it. */
  key: number;
  name: string;
  filter: string;
}

export interface BoardDraft {
  name: string;
  baseFilter: string;
  sort: Sort;
  subIssueMode: SubIssueMode;
  showOther: boolean;
  columns: ColumnDraft[];
}

export interface ColumnProblems {
  name: string | null;
  filter: string | null;
}

export interface BoardProblems {
  name: string | null;
  baseFilter: string | null;
  columns: ColumnProblems[];
  valid: boolean;
}

let lastKey = 0;
const nextKey = () => (lastKey += 1);

export const newColumn = (): ColumnDraft => ({
  key: nextKey(),
  name: "",
  filter: "",
});

export const emptyDraft = (): BoardDraft => ({
  name: "",
  baseFilter: "",
  sort: DEFAULT_SORT,
  subIssueMode: "collapsed",
  showOther: false,
  columns: [newColumn()],
});

export const draftFromBoard = (board: Board): BoardDraft => ({
  name: board.name,
  baseFilter: board.baseFilter,
  sort: board.sort,
  subIssueMode: board.subIssueMode,
  showOther: board.showOther,
  columns: board.columns.map(({ name, filter }) => ({
    key: nextKey(),
    name,
    filter,
  })),
});

/** The parse error of a filter, or `null`; a blank filter is the default one (SPEC FR-11). */
export function filterProblem(filter: string): string | null {
  if (filter.trim() === "") {
    return null;
  }
  const parsed = parse(filter);
  return "error" in parsed ? parsed.error.message : null;
}

const nameProblem = (name: string): string | null => {
  const length = name.trim().length;
  return length >= 1 && length <= BOARD_NAME_MAX
    ? null
    : `Enter a name of 1 to ${BOARD_NAME_MAX} characters.`;
};

/** Checks the draft the way the server does, with the shared parser for the filters (SPEC FR-29). */
export function checkDraft(draft: BoardDraft): BoardProblems {
  const name = nameProblem(draft.name);
  const baseFilter = filterProblem(draft.baseFilter);
  const columns = draft.columns.map((column) => ({
    name: nameProblem(column.name),
    filter: filterProblem(column.filter),
  }));
  return {
    name,
    baseFilter,
    columns,
    valid:
      name === null &&
      baseFilter === null &&
      columns.every((column) => column.name === null && column.filter === null),
  };
}

export const toInput = (draft: BoardDraft): BoardInput => ({
  name: draft.name.trim(),
  baseFilter: draft.baseFilter.trim(),
  sort: draft.sort,
  subIssueMode: draft.subIssueMode,
  showOther: draft.showOther,
  columns: draft.columns.map((column) => ({
    name: column.name.trim(),
    filter: column.filter.trim(),
  })),
});

/** Moves the column at `index` by `by` places; out of range leaves the list as it is. */
export function moveColumn<T>(items: T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (
    index < 0 ||
    index >= items.length ||
    target < 0 ||
    target >= items.length
  ) {
    return items;
  }
  const next = [...items];
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
}
