import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SessionEnv } from "../auth/sessions/index.js";
import type { Db } from "../db/index.js";
import { errorResponse } from "./errors.js";
import {
  boardId,
  boardNotFound,
  insertBoard,
  invalidBoardFilter,
  loadBoard,
} from "./boards.js";
import {
  BOARD_COLUMNS_MAX,
  boardNameSchema,
  sortSchema,
  subIssueModeSchema,
} from "./schemas.js";

export const BOARD_FILE_KIND = "board";
export const BOARD_FILE_VERSION = 1;
/** The largest board file `POST /api/boards/import` reads (SPEC FR-36). */
export const BOARD_FILE_MAX_BYTES = 256 * 1024;

export interface BoardsTransferOptions {
  db: Db;
}

const boardFileSchema = z.object({
  name: boardNameSchema,
  baseFilter: z.string(),
  sort: sortSchema,
  subIssueMode: subIssueModeSchema,
  showOther: z.boolean(),
  columns: z
    .array(z.object({ name: boardNameSchema, filter: z.string() }))
    .min(1)
    .max(BOARD_COLUMNS_MAX),
});

const invalidFile = (c: Parameters<typeof errorResponse>[0], message: string) =>
  errorResponse(c, 400, "invalid_request", message);

/**
 * `GET /api/boards/:id/export` and `POST /api/boards/import` (SPEC FR-36): a
 * board as a JSON file without ids, and a file read back as a new board of
 * the session user. An import never overwrites a board; the board and its
 * columns are created in one transaction after every field and filter has
 * been checked.
 */
export function createBoardTransferRoutes({ db }: BoardsTransferOptions) {
  return new Hono<SessionEnv>()
    .get("/boards/:id/export", (c) => {
      const { userId } = c.var.session;
      const id = boardId(c.req.param("id"));
      const board = id === null ? null : loadBoard(db, userId, id);
      if (board === null) {
        return boardNotFound(c);
      }
      c.header(
        "Content-Disposition",
        `attachment; filename="board-${String(board.id)}.json"`,
      );
      return c.json({
        crossboard: BOARD_FILE_KIND,
        version: BOARD_FILE_VERSION,
        name: board.name,
        baseFilter: board.baseFilter,
        sort: board.sort,
        subIssueMode: board.subIssueMode,
        showOther: board.showOther,
        columns: board.columns.map(({ name, filter }) => ({ name, filter })),
      });
    })
    .post(
      "/boards/import",
      bodyLimit({
        maxSize: BOARD_FILE_MAX_BYTES,
        onError: (c) =>
          errorResponse(
            c,
            413,
            "payload_too_large",
            "A board file is at most 256 KB",
          ),
      }),
      async (c) => {
        const { userId } = c.var.session;
        let file: unknown;
        try {
          file = JSON.parse(await c.req.text());
        } catch {
          return invalidFile(c, "The file is not valid JSON");
        }
        if (typeof file !== "object" || file === null || Array.isArray(file)) {
          return invalidFile(c, "The file must be a JSON object");
        }
        const header = file as Record<string, unknown>;
        if (header.crossboard !== BOARD_FILE_KIND) {
          return invalidFile(
            c,
            'crossboard: expected "board", this is not a Crossboard board file',
          );
        }
        if (header.version !== BOARD_FILE_VERSION) {
          return invalidFile(
            c,
            `version: only version ${String(BOARD_FILE_VERSION)} is supported`,
          );
        }
        const parsed = boardFileSchema.safeParse(file);
        if (!parsed.success) {
          const [issue] = parsed.error.issues;
          return invalidFile(
            c,
            issue === undefined || issue.path.length === 0
              ? "The board file is invalid"
              : `${issue.path.join(".")}: ${issue.message}`,
          );
        }
        const problem = invalidBoardFilter(
          c,
          parsed.data.baseFilter,
          parsed.data.columns,
        );
        if (problem !== null) {
          return problem;
        }
        const id = insertBoard(db, userId, parsed.data);
        const board = loadBoard(db, userId, id);
        return board === null ? boardNotFound(c) : c.json(board, 201);
      },
    );
}
