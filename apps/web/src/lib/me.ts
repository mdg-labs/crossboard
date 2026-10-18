import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";

// errorResponse takes any status, so the error body is part of the typed 200.
export type Me = Extract<
  InferResponseType<typeof api.api.me.$get, 200>,
  { user: unknown }
>;

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me> => {
    const response = await api.api.me.$get();
    if (!response.ok) {
      throw new Error(`The server answered ${response.status}.`);
    }
    return (await response.json()) as Me;
  },
});
