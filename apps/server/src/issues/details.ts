import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import { accessibleRepos } from "../access/index.js";
import {
  issueCommentSchema,
  subIssueSchema,
  type IssueDetails,
} from "../api/schemas.js";
import { schema, type Db } from "../db/index.js";
import {
  GithubError,
  queries,
  type InstallationClient,
} from "../github/index.js";
import { sanitizeGithubHtml } from "../security/index.js";
import { loadAccessibleIssues, type IssueLocator } from "./filterable.js";

const { installations, issueDetails, issues, repos } = schema;

/** A cached copy younger than this is served as it is (SPEC FR-42). */
export const DETAILS_MAX_AGE_MS = 10 * 60 * 1000;

/** Interactive fetches stop below this share of the hourly budget (SPEC §6.5). */
export const DETAILS_BUDGET_FLOOR = 0.02;

const GHOST = "ghost";

const fetchedSchema = z.object({
  node: z
    .object({
      bodyHTML: z.string(),
      comments: z.object({
        totalCount: z.number().int(),
        nodes: z.array(
          z
            .object({
              url: z.string(),
              createdAt: z.string(),
              author: z
                .object({ login: z.string(), avatarUrl: z.string() })
                .nullable(),
              bodyHTML: z.string(),
            })
            .nullable(),
        ),
      }),
      subIssues: z.object({
        totalCount: z.number().int(),
        nodes: z.array(
          z
            .object({
              number: z.number().int(),
              title: z.string(),
              state: z.enum(["OPEN", "CLOSED"]),
              url: z.string(),
              repository: z.object({ nameWithOwner: z.string() }),
            })
            .nullable(),
        ),
      }),
    })
    .nullable(),
});

const storedSubIssuesSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(subIssueSchema),
});

/** A cached copy as `issue_details` holds it; every `bodyHtml` is sanitized. */
interface Stored {
  bodyHtml: string;
  comments: z.infer<typeof issueCommentSchema>[];
  commentsTotal: number;
  subIssues: z.infer<typeof storedSubIssuesSchema>;
  fetchedForUpdatedAt: number;
  fetchedAt: number;
}

/** Why a refetch could not run or finished without a copy. */
export type DetailsFailure =
  | { kind: "not_found" }
  | {
      kind: "unavailable";
      reason: "budget" | "installation";
      /** Epoch milliseconds at which the budget refills, when known. */
      resetAt: number | null;
    }
  | { kind: "github_error"; message: string };

export type DetailsResult =
  { ok: true; details: IssueDetails } | { ok: false; failure: DetailsFailure };

/** A cached copy that does not parse is treated as missing and refetched. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class FailureError extends Error {
  constructor(readonly failure: DetailsFailure) {
    super(failure.kind);
  }
}

export interface IssueDetailsOptions {
  db: Db;
  installations: Pick<InstallationClient, "budgets" | "graphql">;
  /** Whether the installation is active now (SPEC FR-3). */
  isActive: (installationId: number) => boolean;
  logger: Logger;
  now?: () => number;
}

export interface IssueDetailsLoader {
  /**
   * The lazily fetched details of one issue in the user's access (SPEC
   * FR-42). The access is checked before anything else, so an issue that is
   * not synced or not in the access answers `not_found` and sends no GitHub
   * call. A fresh cached copy is served as it is; otherwise the details are
   * fetched, sanitized and stored, and requests for the same issue share one
   * fetch. When the fetch fails the stale copy is served with `stale: true`,
   * or the failure is returned when there is none.
   */
  load(userId: number, locator: IssueLocator): Promise<DetailsResult>;
}

export function createIssueDetails({
  db,
  installations: github,
  isActive,
  logger,
  now = Date.now,
}: IssueDetailsOptions): IssueDetailsLoader {
  const inflight = new Map<string, Promise<Stored>>();

  function readCached(issueId: string): Stored | null {
    const row = db
      .select()
      .from(issueDetails)
      .where(eq(issueDetails.issueId, issueId))
      .get();
    if (row === undefined) return null;
    const comments = z
      .array(issueCommentSchema)
      .safeParse(parseJson(row.commentsJson));
    const subIssues = storedSubIssuesSchema.safeParse(
      parseJson(row.subIssuesJson),
    );
    if (!comments.success || !subIssues.success) return null;
    return {
      bodyHtml: row.bodyHtml,
      comments: comments.data,
      commentsTotal: row.commentsTotal,
      subIssues: subIssues.data,
      fetchedForUpdatedAt: row.fetchedForUpdatedAt,
      fetchedAt: row.fetchedAt,
    };
  }

  const isFresh = (stored: Stored, updatedAt: number): boolean => {
    const age = now() - stored.fetchedAt;
    return (
      stored.fetchedForUpdatedAt === updatedAt &&
      age >= 0 &&
      age < DETAILS_MAX_AGE_MS
    );
  };

  /** Why no call may be made as this installation now, else null. */
  function unavailability(installationId: number): DetailsFailure | null {
    const installation = db
      .select({ suspended: installations.suspended })
      .from(installations)
      .where(eq(installations.id, installationId))
      .get();
    if (
      installation === undefined ||
      installation.suspended ||
      !isActive(installationId)
    ) {
      return { kind: "unavailable", reason: "installation", resetAt: null };
    }
    const budget = github.budgets.get(installationId).graphql;
    if (budget === null) return null;
    // A reset in the past means the figure is out of date, not that the
    // budget is spent.
    if (budget.resetAt !== null && budget.resetAt <= now()) return null;
    const spent =
      budget.limit === null
        ? budget.remaining <= 0
        : budget.remaining < budget.limit * DETAILS_BUDGET_FLOOR;
    return spent
      ? { kind: "unavailable", reason: "budget", resetAt: budget.resetAt }
      : null;
  }

  async function fetchAndStore(
    issueId: string,
    installationId: number,
    repo: string,
    updatedAt: number,
  ): Promise<Stored> {
    const blocked = unavailability(installationId);
    if (blocked !== null) throw new FailureError(blocked);

    let fetched: z.infer<typeof fetchedSchema>;
    try {
      fetched = fetchedSchema.parse(
        await github.graphql(
          installationId,
          queries.issueDetails,
          { id: issueId },
          { repo },
        ),
      );
    } catch (error) {
      const unavailable = unavailability(installationId);
      if (unavailable !== null) throw new FailureError(unavailable);
      if (
        error instanceof GithubError &&
        (error.status === 429 || error.code === "RATE_LIMITED")
      ) {
        throw new FailureError({
          kind: "unavailable",
          reason: "budget",
          resetAt: github.budgets.get(installationId).graphql?.resetAt ?? null,
        });
      }
      logger.warn(
        { err: error, issue: issueId, installationId, repo },
        "fetching issue details failed",
      );
      throw new FailureError({
        kind: "github_error",
        message:
          error instanceof GithubError
            ? error.githubMessage
            : "GitHub returned an unexpected answer",
      });
    }
    if (fetched.node === null) {
      throw new FailureError({
        kind: "github_error",
        message: "GitHub no longer returns this issue",
      });
    }
    const { node } = fetched;

    const stored: Stored = {
      bodyHtml: sanitizeGithubHtml(node.bodyHTML),
      comments: node.comments.nodes.flatMap((comment) =>
        comment === null
          ? []
          : [
              {
                url: comment.url,
                createdAt: Date.parse(comment.createdAt),
                author: comment.author?.login ?? GHOST,
                avatarUrl: comment.author?.avatarUrl ?? null,
                bodyHtml: sanitizeGithubHtml(comment.bodyHTML),
              },
            ],
      ),
      commentsTotal: node.comments.totalCount,
      subIssues: {
        total: node.subIssues.totalCount,
        items: node.subIssues.nodes.flatMap((sub) => {
          if (sub === null) return [];
          const slash = sub.repository.nameWithOwner.indexOf("/");
          return [
            {
              owner: sub.repository.nameWithOwner.slice(0, slash),
              repo: sub.repository.nameWithOwner.slice(slash + 1),
              number: sub.number,
              title: sub.title,
              state: sub.state,
              url: sub.url,
            },
          ];
        }),
      },
      // The version the fetch started from: an issue that changed meanwhile
      // makes the copy stale at once.
      fetchedForUpdatedAt: updatedAt,
      fetchedAt: now(),
    };
    const row = {
      issueId,
      bodyHtml: stored.bodyHtml,
      commentsJson: JSON.stringify(stored.comments),
      commentsTotal: stored.commentsTotal,
      subIssuesJson: JSON.stringify(stored.subIssues),
      fetchedForUpdatedAt: stored.fetchedForUpdatedAt,
      fetchedAt: stored.fetchedAt,
    };
    db.transaction((tx) => {
      // A purge or a removal deletes the issue while it is fetched.
      const present = tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .get();
      if (present === undefined) {
        throw new FailureError({ kind: "not_found" });
      }
      tx.insert(issueDetails)
        .values(row)
        .onConflictDoUpdate({ target: issueDetails.issueId, set: row })
        .run();
    });
    return stored;
  }

  function present(
    stored: Stored,
    userId: number,
    stale: boolean,
  ): IssueDetails {
    const readable = new Set(
      accessibleRepos(db, userId).map((repo) =>
        `${repo.owner}/${repo.name}`.toLowerCase(),
      ),
    );
    const items = stored.subIssues.items.filter((sub) =>
      readable.has(`${sub.owner}/${sub.repo}`.toLowerCase()),
    );
    return {
      bodyHtml: stored.bodyHtml,
      comments: stored.comments,
      commentsTotal: stored.commentsTotal,
      subIssues: {
        total: stored.subIssues.total,
        notAccessible: stored.subIssues.items.length - items.length,
        items,
      },
      fetchedAt: stored.fetchedAt,
      stale,
    };
  }

  return {
    async load(userId, locator) {
      const found = loadAccessibleIssues(db, userId, locator)[0];
      if (found === undefined) {
        return { ok: false, failure: { kind: "not_found" } };
      }
      const { id, updatedAt } = found.item;
      const repo = db
        .select({ installationId: repos.installationId })
        .from(issues)
        .innerJoin(repos, eq(issues.repoId, repos.id))
        .where(eq(issues.id, id))
        .get();
      if (repo === undefined) {
        return { ok: false, failure: { kind: "not_found" } };
      }

      const cached = readCached(id);
      if (cached !== null && isFresh(cached, updatedAt)) {
        return { ok: true, details: present(cached, userId, false) };
      }

      const key = `${id}:${String(updatedAt)}`;
      let pending = inflight.get(key);
      if (pending === undefined) {
        pending = fetchAndStore(
          id,
          repo.installationId,
          `${found.item.repo.owner}/${found.item.repo.name}`,
          updatedAt,
        ).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      try {
        return { ok: true, details: present(await pending, userId, false) };
      } catch (error) {
        if (!(error instanceof FailureError)) throw error;
        if (cached !== null && error.failure.kind !== "not_found") {
          return { ok: true, details: present(cached, userId, true) };
        }
        return { ok: false, failure: error.failure };
      }
    },
  };
}
