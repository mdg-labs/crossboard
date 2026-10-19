import { parse } from "@crossboard/query";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { SessionEnv } from "../auth/sessions/index.js";
import {
  boardCardsQuerySchema,
  composeBoardCards,
  parseFilter,
} from "../boards/index.js";
import { schema, type Db } from "../db/index.js";
import { loadAccessibleIssues } from "../issues/index.js";
import { errorResponse, invalidQueryResponse } from "./errors.js";
import { boardCreateSchema, boardPatchSchema, type Board } from "./schemas.js";
import { validate } from "./validator.js";

const { boards, boardColumns } = schema;

export interface BoardsOptions {
  db: Db;
}

interface ColumnInput {
  name: string;
  filter: string;
}

const boardNotFound = (c: Context) =>
  errorResponse(c, 404, "not_found", "Not found");

/** A blank filter means the default one, as it does for the list (SPEC FR-11). */
function invalidFilter(
  c: Context,
  filter: string,
  where: { label: string; field: string },
) {
  const parsed = parse(filter.trim() === "" ? "is:open" : filter);
  if (!("error" in parsed)) {
    return null;
  }
  return invalidQueryResponse(c, parsed.error, where);
}

/** The first filter of a board that does not parse, the base filter first (SPEC FR-29). */
function invalidBoardFilter(
  c: Context,
  baseFilter: string | undefined,
  columns: ColumnInput[] | undefined,
) {
  if (baseFilter !== undefined) {
    const problem = invalidFilter(c, baseFilter, {
      label: "Base filter",
      field: "baseFilter",
    });
    if (problem !== null) {
      return problem;
    }
  }
  for (const [index, column] of (columns ?? []).entries()) {
    const problem = invalidFilter(c, column.filter, {
      label: `Column ${String(index + 1)} "${column.name}"`,
      field: `columns.${String(index)}.filter`,
    });
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

const toBoard = (
  row: typeof boards.$inferSelect,
  columns: (typeof boardColumns.$inferSelect)[],
): Board => ({
  id: row.id,
  name: row.name,
  baseFilter: row.baseFilter,
  sort: row.sort as Board["sort"],
  subIssueMode: row.subIssueMode as Board["subIssueMode"],
  showOther: row.showOther,
  columns: columns
    .filter((column) => column.boardId === row.id)
    .sort((a, b) => a.position - b.position)
    .map(({ id, name, filter }) => ({ id, name, filter })),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The id of a path segment that is a positive integer, otherwise `null`. */
const boardId = (raw: string): number | null =>
  /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;

const byName = (a: Board, b: Board) => {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a.id - b.id;
};

const columnRows = (boardIdValue: number, columns: ColumnInput[]) =>
  columns.map((column, position) => ({
    boardId: boardIdValue,
    position,
    name: column.name,
    filter: column.filter.trim(),
  }));

/**
 * `GET`, `POST /api/boards` and `GET`, `PATCH`, `DELETE /api/boards/:id` (SPEC
 * FR-28, FR-29, FR-35, §7.4): the session user's boards with their columns.
 * `GET /api/boards/:id/cards?q=` places the user's accessible issues in the
 * board's columns (FR-30, FR-31, FR-33, FR-34).
 * Every statement carries the session user, so another user's board id is a
 * `404` on every route (D-2). A board and its columns change in one
 * transaction, so a failed write leaves the board as it was.
 */
export function createBoardRoutes({ db }: BoardsOptions) {
  const load = (userId: number, id: number): Board | null => {
    const row = db
      .select()
      .from(boards)
      .where(and(eq(boards.id, id), eq(boards.userId, userId)))
      .get();
    if (row === undefined) {
      return null;
    }
    const columns = db
      .select()
      .from(boardColumns)
      .where(eq(boardColumns.boardId, id))
      .orderBy(asc(boardColumns.position))
      .all();
    return toBoard(row, columns);
  };

  return new Hono<SessionEnv>()
    .get("/boards", (c) => {
      const { userId } = c.var.session;
      const rows = db
        .select()
        .from(boards)
        .where(eq(boards.userId, userId))
        .all();
      const columns =
        rows.length === 0
          ? []
          : db
              .select()
              .from(boardColumns)
              .where(
                inArray(
                  boardColumns.boardId,
                  rows.map((row) => row.id),
                ),
              )
              .all();
      const items = rows.map((row) => toBoard(row, columns)).sort(byName);
      return c.json({ items });
    })
    .post("/boards", validate("json", boardCreateSchema), (c) => {
      const { userId } = c.var.session;
      const input = c.req.valid("json");
      const problem = invalidBoardFilter(c, input.baseFilter, input.columns);
      if (problem !== null) {
        return problem;
      }
      const now = Date.now();
      const id = db.transaction((tx) => {
        const row = tx
          .insert(boards)
          .values({
            userId,
            name: input.name,
            baseFilter: input.baseFilter.trim(),
            sort: input.sort,
            subIssueMode: input.subIssueMode,
            showOther: input.showOther,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: boards.id })
          .get();
        tx.insert(boardColumns).values(columnRows(row.id, input.columns)).run();
        return row.id;
      });
      const board = load(userId, id);
      return board === null ? boardNotFound(c) : c.json(board, 201);
    })
    .get("/boards/:id", (c) => {
      const { userId } = c.var.session;
      const id = boardId(c.req.param("id"));
      const board = id === null ? null : load(userId, id);
      return board === null ? boardNotFound(c) : c.json(board);
    })
    .get("/boards/:id/cards", validate("query", boardCardsQuerySchema), (c) => {
      const { userId } = c.var.session;
      const id = boardId(c.req.param("id"));
      const board = id === null ? null : load(userId, id);
      if (board === null) {
        return boardNotFound(c);
      }
      const user = db
        .select({ login: schema.users.login })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .get();
      if (user === undefined) {
        return errorResponse(
          c,
          401,
          "unauthorized",
          "Sign in to use this instance",
        );
      }

      const adHoc = parseFilter(c.req.valid("query").q);
      if ("error" in adHoc) {
        return invalidQueryResponse(c, adHoc.error);
      }
      const base = parseFilter(board.baseFilter);
      if ("error" in base) {
        return invalidQueryResponse(c, base.error, {
          label: "Base filter",
          field: "baseFilter",
        });
      }
      const columns = [];
      for (const [index, column] of board.columns.entries()) {
        const parsed = parseFilter(column.filter);
        if ("error" in parsed) {
          return invalidQueryResponse(c, parsed.error, {
            label: `Column ${String(index + 1)} "${column.name}"`,
            field: `columns.${String(index)}.filter`,
          });
        }
        columns.push(parsed.ast);
      }

      const cards = composeBoardCards(
        board,
        { base: base.ast, adHoc: adHoc.ast, columns },
        loadAccessibleIssues(db, userId),
        user.login,
      );
      return c.json({ ...cards, warnings: adHoc.warnings });
    })
    .patch("/boards/:id", validate("json", boardPatchSchema), (c) => {
      const { userId } = c.var.session;
      const id = boardId(c.req.param("id"));
      if (id === null) {
        return boardNotFound(c);
      }
      const patch = c.req.valid("json");
      const problem = invalidBoardFilter(c, patch.baseFilter, patch.columns);
      if (problem !== null) {
        return problem;
      }
      const updated = db.transaction((tx) => {
        const row = tx
          .update(boards)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.baseFilter === undefined
              ? {}
              : { baseFilter: patch.baseFilter.trim() }),
            ...(patch.sort === undefined ? {} : { sort: patch.sort }),
            ...(patch.subIssueMode === undefined
              ? {}
              : { subIssueMode: patch.subIssueMode }),
            ...(patch.showOther === undefined
              ? {}
              : { showOther: patch.showOther }),
            updatedAt: Date.now(),
          })
          .where(and(eq(boards.id, id), eq(boards.userId, userId)))
          .returning({ id: boards.id })
          .get();
        if (row === undefined) {
          return false;
        }
        if (patch.columns !== undefined) {
          tx.delete(boardColumns).where(eq(boardColumns.boardId, id)).run();
          tx.insert(boardColumns).values(columnRows(id, patch.columns)).run();
        }
        return true;
      });
      const board = updated ? load(userId, id) : null;
      return board === null ? boardNotFound(c) : c.json(board);
    })
    .delete("/boards/:id", (c) => {
      const { userId } = c.var.session;
      const id = boardId(c.req.param("id"));
      if (id === null) {
        return boardNotFound(c);
      }
      const row = db
        .delete(boards)
        .where(and(eq(boards.id, id), eq(boards.userId, userId)))
        .returning({ id: boards.id })
        .get();
      return row === undefined ? boardNotFound(c) : c.body(null, 204);
    });
}
