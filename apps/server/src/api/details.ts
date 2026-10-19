import { Hono } from "hono";
import type { SessionEnv } from "../auth/sessions/index.js";
import type { IssueDetailsLoader } from "../issues/index.js";
import { errorResponse, type ApiErrorBody } from "./errors.js";
import { issueParamsSchema } from "./schemas.js";
import { validate } from "./validator.js";

export interface DetailsOptions {
  details: IssueDetailsLoader;
}

/**
 * `GET /api/issues/:owner/:repo/:number/details` (SPEC §7.4, FR-42): the
 * lazily fetched body, comments and sub-issues of one synced issue, `404` for
 * an issue that is not synced or not in the user's access. When GitHub cannot
 * be asked and no copy exists the answer is `503` (budget spent or
 * installation suspended, with `resetAt` when known) or `502` (GitHub error).
 */
export function createDetailRoutes({ details }: DetailsOptions) {
  return new Hono<SessionEnv>().get(
    "/issues/:owner/:repo/:number/details",
    validate("param", issueParamsSchema),
    async (c) => {
      const result = await details.load(
        c.var.session.userId,
        c.req.valid("param"),
      );
      if (result.ok) return c.json(result.details);

      const { failure } = result;
      switch (failure.kind) {
        case "not_found":
          return errorResponse(c, 404, "not_found", "Not found");
        case "github_error":
          return errorResponse(
            c,
            502,
            "github_error",
            `GitHub could not return the details: ${failure.message}`,
          );
        case "unavailable": {
          const body: ApiErrorBody & { error: { resetAt: number | null } } = {
            error: {
              code:
                failure.reason === "budget"
                  ? "github_rate_limited"
                  : "installation_unavailable",
              message:
                failure.reason === "budget"
                  ? "The GitHub rate limit for this installation is nearly spent"
                  : "The GitHub installation for this repository is suspended or inactive",
              resetAt: failure.resetAt,
            },
          };
          return c.json(body, 503);
        }
      }
    },
  );
}
