import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";
import { failure } from "@/lib/views";

const syncRoute = api.api.sync.$get;

export type SyncStatus = Extract<
  InferResponseType<typeof syncRoute, 200>,
  { repos: unknown }
>;
export type SyncRepo = SyncStatus["repos"][number];
export type SyncState = SyncRepo["state"];
export type SyncInstallation = SyncStatus["installations"][number];
export type SyncBudget = NonNullable<SyncInstallation["rest"]>;

/** How often the top bar and the settings page ask again. */
export const SYNC_POLL_MS = 30_000;

export const syncQuery = queryOptions({
  queryKey: ["sync"],
  queryFn: async ({ signal }): Promise<SyncStatus> => {
    const response = await syncRoute(undefined, { init: { signal } });
    if (!response.ok) {
      throw await failure(response);
    }
    return (await response.json()) as SyncStatus;
  },
  refetchInterval: SYNC_POLL_MS,
});

/**
 * Asks the server to reconcile the user's repos (SPEC FR-45). A refresh inside
 * the 60 s window rejects with the server's `429` message.
 */
export async function refreshSync(): Promise<void> {
  const response = await api.api.sync.refresh.$post();
  if (!response.ok) {
    throw await failure(response);
  }
}
