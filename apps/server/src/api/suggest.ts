import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { inUserAccess } from "../access/index.js";
import type { SessionEnv } from "../auth/sessions/index.js";
import { schema, type Db } from "../db/index.js";
import {
  SUGGEST_LIMIT,
  suggestQuerySchema,
  type SuggestField,
  type Suggestions,
} from "./schemas.js";
import { validate } from "./validator.js";

const { issueAssignees, issues, labels, repos } = schema;

export interface SuggestOptions {
  db: Db;
}

/**
 * Every distinct value of `field` in the repos of `userId`'s access. The
 * access condition is part of each query: a value that only exists in a repo
 * the user cannot see is never read (SPEC §9.1).
 */
function valuesOf(db: Db, userId: number, field: SuggestField): string[] {
  switch (field) {
    case "label":
      return db
        .selectDistinct({ value: labels.name })
        .from(labels)
        .where(inUserAccess(db, userId, labels.repoId))
        .all()
        .map((row) => row.value);
    case "assignee":
      return db
        .selectDistinct({ value: issueAssignees.login })
        .from(issueAssignees)
        .innerJoin(issues, eq(issueAssignees.issueId, issues.id))
        .where(inUserAccess(db, userId, issues.repoId))
        .all()
        .map((row) => row.value);
    case "author":
      return db
        .selectDistinct({ value: issues.authorLogin })
        .from(issues)
        .where(
          and(
            isNotNull(issues.authorLogin),
            inUserAccess(db, userId, issues.repoId),
          ),
        )
        .all()
        .flatMap((row) => (row.value === null ? [] : [row.value]));
    case "repo":
      return db
        .select({ owner: repos.owner, name: repos.name })
        .from(repos)
        .where(inUserAccess(db, userId, repos.id))
        .all()
        .map((row) => `${row.owner}/${row.name}`);
    case "org":
    case "user":
      return db
        .selectDistinct({ value: repos.owner })
        .from(repos)
        .where(inUserAccess(db, userId, repos.id))
        .all()
        .map((row) => row.value);
    case "type":
      return db
        .selectDistinct({ value: issues.typeName })
        .from(issues)
        .where(
          and(
            isNotNull(issues.typeName),
            inUserAccess(db, userId, issues.repoId),
          ),
        )
        .all()
        .flatMap((row) => (row.value === null ? [] : [row.value]));
    case "milestone":
      return db
        .selectDistinct({ value: issues.milestoneTitle })
        .from(issues)
        .where(
          and(
            isNotNull(issues.milestoneTitle),
            inUserAccess(db, userId, issues.repoId),
          ),
        )
        .all()
        .flatMap((row) => (row.value === null ? [] : [row.value]));
  }
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Case-insensitive, with the exact spelling breaking ties so the order is stable. */
const compareValues = (a: string, b: string) =>
  compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);

/**
 * `GET /api/suggest?field=&prefix=` (SPEC FR-20): up to 20 distinct values of
 * a qualifier from the session user's accessible cached data, matched by
 * case-insensitive prefix. `org` and `user` are the same field.
 */
export function createSuggestRoutes({ db }: SuggestOptions) {
  return new Hono<SessionEnv>().get(
    "/suggest",
    validate("query", suggestQuerySchema),
    (c) => {
      const { field, prefix } = c.req.valid("query");
      const wanted = prefix.toLowerCase();
      const values = valuesOf(db, c.var.session.userId, field)
        .filter((value) => value.toLowerCase().startsWith(wanted))
        .sort(compareValues)
        .slice(0, SUGGEST_LIMIT);
      const body: Suggestions = { values };
      return c.json(body);
    },
  );
}
