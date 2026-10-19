import { evaluate, parse, type Node } from "@crossboard/query";
import { z } from "zod";
import {
  issueItemSchema,
  queryWarningSchema,
  type Board,
  type IssueItem,
} from "../api/schemas.js";
import { sortIssues, type AccessibleIssue } from "../issues/index.js";
import { nestCards, type CardOf } from "./nesting.js";
import { OTHER, placeIssues, type Slot } from "./placement.js";

/** What an empty filter means (SPEC FR-11). */
export const DEFAULT_FILTER = "is:open";

export const OTHER_NAME = "Other";

export type BoardCard = CardOf<IssueItem>;

export const boardCardSchema: z.ZodType<BoardCard> = issueItemSchema.extend({
  children: z.lazy(() => z.array(boardCardSchema)).optional(),
  columnName: z.string().optional(),
});

export const boardCardsQuerySchema = z.object({ q: z.string().default("") });

/** The cards route's response (SPEC §7.4); `other` is present when the board shows it. */
export const boardCardsSchema = z.object({
  columns: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      count: z.number().int().nonnegative(),
      cards: z.array(boardCardSchema),
    }),
  ),
  other: z
    .object({
      count: z.number().int().nonnegative(),
      cards: z.array(boardCardSchema),
    })
    .optional(),
  warnings: z.array(queryWarningSchema),
});

export type BoardCards = Omit<z.infer<typeof boardCardsSchema>, "warnings">;

/** A filter that is blank means the default one, as it does for the list. */
export const parseFilter = (filter: string) =>
  parse(filter.trim() === "" ? DEFAULT_FILTER : filter);

export interface BoardFilters {
  base: Node;
  /** The ad-hoc filter of FR-34. */
  adHoc: Node;
  columns: Node[];
}

/**
 * Places the viewer's accessible issues on a board (SPEC FR-30, FR-31, FR-33):
 * an issue matching the base filter and the ad-hoc filter goes to the first
 * column whose filter matches it, else to "Other" when the board shows it.
 * `issues` is everything the viewer can read; nesting follows parents through
 * all of it, not only through the issues that matched.
 */
export function composeBoardCards(
  board: Pick<Board, "columns" | "sort" | "subIssueMode" | "showOther">,
  filters: BoardFilters,
  issues: readonly AccessibleIssue[],
  viewerLogin: string,
): BoardCards {
  const context = { viewerLogin };
  const sorted = sortIssues(issues, board.sort);
  const byId = new Map(sorted.map((issue) => [issue.item.id, issue]));
  const candidates = sorted.filter(
    (issue) =>
      evaluate(filters.base, issue.filterable, context) &&
      evaluate(filters.adHoc, issue.filterable, context),
  );
  const placed = placeIssues(
    candidates.map((issue) => issue.item),
    filters.columns.map((ast) => (item: IssueItem) => {
      const issue = byId.get(item.id);
      return issue !== undefined && evaluate(ast, issue.filterable, context);
    }),
    board.showOther,
  );
  const names = board.columns.map((column) => column.name);
  const slots = nestCards({
    synced: sorted.map((issue) => issue.item),
    placed,
    toCard: (item) => ({ ...item }),
    slotName: (slot: Slot) =>
      slot === OTHER ? OTHER_NAME : (names[slot] ?? ""),
    mode: board.subIssueMode,
  });

  const cardsOf = (slot: Slot) => slots.get(slot) ?? [];
  return {
    columns: board.columns.map((column, index) => ({
      id: column.id,
      name: column.name,
      count: cardsOf(index).length,
      cards: cardsOf(index),
    })),
    ...(board.showOther
      ? {
          other: {
            count: cardsOf(OTHER).length,
            cards: cardsOf(OTHER),
          },
        }
      : {}),
  };
}
