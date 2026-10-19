import { infiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api } from "@/lib/api";

const issuesRoute = api.api.issues.$get;

type IssuesResponse = InferResponseType<typeof issuesRoute, 200>;

export type IssueList = Extract<IssuesResponse, { items: unknown }>;
export type IssueItem = IssueList["items"][number];
export type Sort = NonNullable<
  InferRequestType<typeof issuesRoute>["query"]["sort"]
>;

export const DEFAULT_SORT: Sort = "updated-desc";

/** Rows per request (SPEC FR-13). */
export const PAGE_SIZE = 100;

const SORT_LABELS: Record<Sort, string> = {
  "updated-desc": "Recently updated",
  "updated-asc": "Least recently updated",
  "created-desc": "Newest",
  "created-asc": "Oldest",
  "repo-asc": "Repository",
  "title-asc": "Title",
};

export const SORT_ITEMS = (Object.keys(SORT_LABELS) as Sort[]).map((value) => ({
  value,
  label: SORT_LABELS[value],
}));

export interface IndexSearch {
  q?: string;
  sort?: Sort;
}

/** The filter and sort of the list as the URL carries them (SPEC FR-19). */
export function parseIndexSearch(search: Record<string, unknown>): IndexSearch {
  // The router parses a value that reads as JSON, so `?q=123` arrives as 123.
  const raw = search.q;
  const q =
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
      ? String(raw)
      : "";
  const sort = SORT_ITEMS.find((item) => item.value === search.sort)?.value;
  return {
    ...(q === "" ? {} : { q }),
    ...(sort === undefined || sort === DEFAULT_SORT ? {} : { sort }),
  };
}

async function failure(response: Response): Promise<Error> {
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
      return new Error(body.error.message);
    }
  } catch {
    // The body is not the API's error shape; fall back to the status.
  }
  return new Error(`The server answered ${response.status}.`);
}

export const issuesQuery = (q: string, sort: Sort) =>
  infiniteQueryOptions({
    queryKey: ["issues", { q, sort }],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }): Promise<IssueList> => {
      const response = await issuesRoute(
        {
          query: {
            q,
            sort,
            offset: String(pageParam),
            limit: String(PAGE_SIZE),
          },
        },
        { init: { signal } },
      );
      if (!response.ok) {
        throw await failure(response);
      }
      return (await response.json()) as IssueList;
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
  });

/**
 * The loaded pages as one list. Pages are fetched by offset, so an issue that
 * moves in the sort order between two requests comes back twice; only its
 * first occurrence is kept, so every row has a unique key.
 */
export function loadedIssues(
  data: InfiniteData<IssueList> | undefined,
): IssueItem[] {
  if (data === undefined) {
    return [];
  }
  const seen = new Set<IssueItem["id"]>();
  return data.pages
    .flatMap((page) => page.items)
    .filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    });
}
