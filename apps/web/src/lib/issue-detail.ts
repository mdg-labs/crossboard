import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "@/lib/api";

const summaryRoute = api.api.issues[":owner"][":repo"][":number"].$get;
const detailsRoute = api.api.issues[":owner"][":repo"][":number"].details.$get;

// errorResponse takes any status, so the error body is part of the typed 200.
export type IssueSummary = Extract<
  InferResponseType<typeof summaryRoute, 200>,
  { blockedBy: unknown }
>;
export type IssueDetails = Extract<
  InferResponseType<typeof detailsRoute, 200>,
  { bodyHtml: string }
>;
export type IssueRelation = IssueSummary["blockedBy"]["items"][number];
export type SubIssue = IssueDetails["subIssues"]["items"][number];
export type IssueComment = IssueDetails["comments"][number];

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** The comments the details route returns at most (SPEC FR-43). */
export const MAX_COMMENTS = 100;
/** The sub-issues the details route returns at most (SPEC FR-43). */
export const MAX_SUB_ISSUES = 50;

export const detailPath = (ref: IssueRef): string =>
  `/i/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${String(ref.number)}`;

export const sameIssue = (a: IssueRef, b: IssueRef): boolean =>
  a.owner === b.owner && a.repo === b.repo && a.number === b.number;

/** A failed detail request; `resetAt` is when a spent GitHub budget refills. */
export class DetailError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly resetAt: number | null,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<DetailError> {
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
      const resetAt =
        "resetAt" in body.error && typeof body.error.resetAt === "number"
          ? body.error.resetAt
          : null;
      return new DetailError(body.error.message, response.status, resetAt);
    }
  } catch {
    // The body is not the API's error shape; fall back to the status.
  }
  return new DetailError(
    `The server answered ${String(response.status)}.`,
    response.status,
    null,
  );
}

const param = (ref: IssueRef) => ({
  owner: ref.owner,
  repo: ref.repo,
  number: String(ref.number),
});

export const issueSummaryQuery = (ref: IssueRef) =>
  queryOptions({
    queryKey: ["issue", ref.owner, ref.repo, ref.number],
    // A failure shows an error with a retry button, not a silent second try.
    retry: false,
    queryFn: async ({ signal }): Promise<IssueSummary> => {
      const response = await summaryRoute(
        { param: param(ref) },
        { init: { signal } },
      );
      if (!response.ok) {
        throw await failure(response);
      }
      return (await response.json()) as IssueSummary;
    },
  });

export const issueDetailsQuery = (ref: IssueRef) =>
  queryOptions({
    queryKey: ["issue", ref.owner, ref.repo, ref.number, "details"],
    retry: false,
    queryFn: async ({ signal }): Promise<IssueDetails> => {
      const response = await detailsRoute(
        { param: param(ref) },
        { init: { signal } },
      );
      if (!response.ok) {
        throw await failure(response);
      }
      return (await response.json()) as IssueDetails;
    },
  });
