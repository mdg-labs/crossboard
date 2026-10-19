import { evaluate, parse } from "@crossboard/query";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionEnv } from "../auth/sessions/index.js";
import { schema, type Db } from "../db/index.js";
import {
  loadAccessibleIssues,
  loadIssueSummary,
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

/**
 * `GET /api/issues?q=&sort=&offset=&limit=` (SPEC §7.4): the session user's
 * accessible open issues, filtered in memory with `packages/query`, sorted and
 * paged here. A syntax error answers `400` with its range (FR-18); warnings
 * ride along with the result (FR-17).
 *
 * `GET /api/issues/:owner/:repo/:number` (SPEC §7.4): one synced issue with its
 * dependency lists and its parent's title and state; `404` for an issue that
 * is not synced or not in the user's access.
 */
export function createIssueRoutes({ db }: IssuesOptions) {
  return new Hono<SessionEnv>()
    .get("/issues", validate("query", issueListQuerySchema), (c) => {
      const { q, sort, offset, limit } = c.req.valid("query");
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
      const matching = loadAccessibleIssues(db, userId).filter((issue) =>
        evaluate(parsed.ast, issue.filterable, context),
      );
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
