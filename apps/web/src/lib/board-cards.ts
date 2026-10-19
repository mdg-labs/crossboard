import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";
import { parseIndexSearch } from "@/lib/issues";
import { failure } from "@/lib/views";

const cardsRoute = api.api.boards[":id"].cards.$get;

export type BoardCards = Extract<
  InferResponseType<typeof cardsRoute, 200>,
  { columns: unknown }
>;
export type BoardColumnCards = BoardCards["columns"][number];
export type BoardCard = BoardColumnCards["cards"][number];

export interface BoardSearch {
  q?: string;
}

/** The ad-hoc filter of a board as the URL carries it (SPEC FR-34). */
export function parseBoardSearch(search: Record<string, unknown>): BoardSearch {
  const { q } = parseIndexSearch(search);
  return q === undefined ? {} : { q };
}

/** The id of the board a path shows (`/b/:boardId`), else `null`. */
export function boardPathId(pathname: string): number | null {
  const id = /^\/b\/([1-9][0-9]{0,15})\/?$/.exec(pathname)?.[1];
  return id === undefined ? null : Number(id);
}

/** `GET /api/boards/:id/cards?q=` (SPEC §7.4): every placed card of the board. */
export const boardCardsQuery = (id: number, q: string) =>
  queryOptions({
    queryKey: ["boards", id, "cards", { q }],
    queryFn: async ({ signal }): Promise<BoardCards> => {
      const response = await cardsRoute(
        { param: { id: String(id) }, query: { q } },
        { init: { signal } },
      );
      if (!response.ok) {
        throw await failure(response);
      }
      return (await response.json()) as BoardCards;
    },
  });
