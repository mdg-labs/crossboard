import { evaluate, parse } from "@crossboard/query";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionEnv } from "../auth/sessions/index.js";
import { schema, type Db } from "../db/index.js";
import { loadAccessibleIssues, sortIssues } from "../issues/index.js";
import { errorResponse, type ApiErrorBody } from "./errors.js";
import { issueListQuerySchema, type IssueList } from "./schemas.js";
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
 */
export function createIssueRoutes({ db }: IssuesOptions) {
  return new Hono<SessionEnv>().get(
    "/issues",
    validate("query", issueListQuerySchema),
    (c) => {
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
        const body: ApiErrorBody & { error: { start: number; end: number } } = {
          error: {
            code: "invalid_query",
            message: parsed.error.message,
            start: parsed.error.start,
            end: parsed.error.end,
          },
        };
        return c.json(body, 400);
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
    },
  );
}
