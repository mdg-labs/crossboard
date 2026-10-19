import { queryOptions } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api } from "@/lib/api";

const suggestRoute = api.api.suggest.$get;

/** The qualifiers `GET /api/suggest` completes values for (SPEC FR-20). */
export type SuggestField = InferRequestType<
  typeof suggestRoute
>["query"]["field"];

export type Suggestions = Extract<
  InferResponseType<typeof suggestRoute, 200>,
  { values: unknown }
>;

export const suggestQuery = (field: SuggestField, prefix: string) =>
  queryOptions({
    queryKey: ["suggest", field, prefix],
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<string[]> => {
      const response = await suggestRoute(
        { query: { field, prefix } },
        { init: { signal } },
      );
      if (!response.ok) {
        throw new Error(`The server answered ${response.status}.`);
      }
      return ((await response.json()) as Suggestions).values;
    },
  });
