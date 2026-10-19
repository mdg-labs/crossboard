import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/views";

const boardsRoute = api.api.boards.$get;

export type Boards = Extract<
  InferResponseType<typeof boardsRoute, 200>,
  { items: unknown }
>;
export type Board = Boards["items"][number];
export type BoardColumn = Board["columns"][number];
export type SubIssueMode = Board["subIssueMode"];

/** What the form sends: the whole board, with its columns in order (SPEC FR-28). */
export type BoardInput = InferRequestType<typeof api.api.boards.$post>["json"];

export const BOARD_NAME_MAX = 100;
export const BOARD_COLUMNS_MAX = 20;

export const SUB_ISSUE_MODE_ITEMS: { value: SubIssueMode; label: string }[] = [
  { value: "collapsed", label: "Collapsed" },
  { value: "expanded", label: "Expanded" },
];

async function failure(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      const code =
        "code" in body.error && typeof body.error.code === "string"
          ? body.error.code
          : null;
      return new ApiError(response.status, code, body.error.message);
    }
  } catch {
    // The body is not the API's error shape; fall back to the status.
  }
  return new ApiError(
    response.status,
    null,
    `The server answered ${response.status}.`,
  );
}

export const boardsQuery = queryOptions({
  queryKey: ["boards"],
  queryFn: async ({ signal }): Promise<Board[]> => {
    const response = await boardsRoute(undefined, { init: { signal } });
    if (!response.ok) {
      throw await failure(response);
    }
    return ((await response.json()) as Boards).items;
  },
});

export const boardQuery = (id: number) =>
  queryOptions({
    queryKey: ["boards", id],
    queryFn: async ({ signal }): Promise<Board> => {
      const response = await api.api.boards[":id"].$get(
        { param: { id: String(id) } },
        { init: { signal } },
      );
      if (!response.ok) {
        throw await failure(response);
      }
      return (await response.json()) as Board;
    },
  });

export async function createBoard(board: BoardInput): Promise<Board> {
  const response = await api.api.boards.$post({ json: board });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as Board;
}

export async function updateBoard(
  id: number,
  board: BoardInput,
): Promise<Board> {
  const response = await api.api.boards[":id"].$patch({
    param: { id: String(id) },
    json: board,
  });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as Board;
}

export async function deleteBoard(id: number): Promise<void> {
  const response = await api.api.boards[":id"].$delete({
    param: { id: String(id) },
  });
  if (!response.ok) {
    throw await failure(response);
  }
}
