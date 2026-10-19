import { evaluate, parse } from "@crossboard/query";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionEnv } from "../auth/sessions/index.js";
import { schema, type Db } from "../db/index.js";
import {
  loadAccessibleIssues,
  loadIssueSummary,
  nestCards,
  sortIssues,
} from "../issues/index.js";
import { errorResponse, invalidQueryResponse } from "./errors.js";
import {
  issueListQuerySchema,
  issueParamsSchema,
  type IssueList,
} from "./schemas.js";
import { validate } from "./validator.js";

export interface IssuesOptions {
  db: Db;
}

/** What an empty filter means (SPEC FR-11). */
const DEFAULT_FILTER = "is:open";

/** The one slot the nested list places every matched issue in. */
const LIST_SLOT = 0;

/**
 * `GET /api/issues?q=&sort=&offset=&limit=&nest=` (SPEC §7.4): the session
 * user's accessible open issues, filtered in memory with `packages/query`,
 * sorted and paged here. A syntax error answers `400` with its range (FR-18);
 * warnings ride along with the result (FR-17). With `nest=true` a matched
 * issue is listed under its nearest matched ancestor (FR-12, FR-31), and the
 * paging counts top-level issues.
 *
 * `GET /api/issues/:owner/:repo/:number` (SPEC §7.4): one synced issue with its
 * dependency lists and its parent's title and state; `404` for an issue that
 * is not synced or not in the user's access.
 */
export function createIssueRoutes({ db }: IssuesOptions) {
  return new Hono<SessionEnv>()
    .get("/issues", validate("query", issueListQuerySchema), (c) => {
      const { q, sort, offset, limit, nest } = c.req.valid("query");
      const { userId } = c.var.session;
      const user = db
        .select({ login: schema.users.login })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .get();
      if (user === undefined) {
        return errorResponse(
          c,
          401,
          "unauthorized",
          "Sign in to use this instance",
        );
      }

      const parsed = parse(q.trim() === "" ? DEFAULT_FILTER : q);
      if ("error" in parsed) {
        return invalidQueryResponse(c, parsed.error);
      }

      const context = { viewerLogin: user.login };
      const accessible = loadAccessibleIssues(db, userId);
      const matching = accessible.filter((issue) =>
        evaluate(parsed.ast, issue.filterable, context),
      );
      if (nest) {
        const synced = sortIssues(accessible, sort).map((issue) => issue.item);
        const matchedIds = new Set(matching.map((issue) => issue.item.id));
        const topLevel =
          nestCards({
            synced,
            placed: new Map(
              synced
                .filter((item) => matchedIds.has(item.id))
                .map((item) => [item.id, LIST_SLOT]),
            ),
            toCard: (item) => ({ ...item }),
            mode: "collapsed",
          }).get(LIST_SLOT) ?? [];
        const nested: IssueList = {
          items: topLevel.slice(offset, offset + limit),
          total: topLevel.length,
          matched: matching.length,
          warnings: parsed.warnings,
        };
        return c.json(nested);
      }
      const result: IssueList = {
        items: sortIssues(matching, sort)
          .slice(offset, offset + limit)
          .map((issue) => issue.item),
        total: matching.length,
        warnings: parsed.warnings,
      };
      return c.json(result);
    })
    .get(
      "/issues/:owner/:repo/:number",
      validate("param", issueParamsSchema),
      (c) => {
        const { owner, repo, number } = c.req.valid("param");
        const summary = loadIssueSummary(db, c.var.session.userId, {
          owner,
          repo,
          number,
        });
        if (summary === null) {
          return errorResponse(c, 404, "not_found", "Not found");
        }
        return c.json(summary);
      },
    );
}
