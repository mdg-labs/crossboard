import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";
import type { Sort } from "@/lib/issues";

const viewsRoute = api.api.views.$get;

export type SavedViews = Extract<
  InferResponseType<typeof viewsRoute, 200>,
  { items: unknown }
>;
export type SavedView = SavedViews["items"][number];

/** A failed request, with what the server said about it. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The error a failed API response carries, else one naming its status. */
export async function failure(response: Response): Promise<ApiError> {
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

export const viewsQuery = queryOptions({
  queryKey: ["views"],
  queryFn: async ({ signal }): Promise<SavedView[]> => {
    const response = await viewsRoute(undefined, { init: { signal } });
    if (!response.ok) {
      throw await failure(response);
    }
    return ((await response.json()) as SavedViews).items;
  },
});

export async function createView(view: {
  name: string;
  filter: string;
  sort: Sort;
}): Promise<SavedView> {
  const response = await api.api.views.$post({ json: view });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as SavedView;
}

export async function renameView(id: number, name: string): Promise<SavedView> {
  const response = await api.api.views[":id"].$patch({
    param: { id: String(id) },
    json: { name },
  });
  if (!response.ok) {
    throw await failure(response);
  }
  return (await response.json()) as SavedView;
}

export async function deleteView(id: number): Promise<void> {
  const response = await api.api.views[":id"].$delete({
    param: { id: String(id) },
  });
  if (!response.ok) {
    throw await failure(response);
  }
}
