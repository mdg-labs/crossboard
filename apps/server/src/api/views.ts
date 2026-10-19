import { parse } from "@crossboard/query";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { SessionEnv } from "../auth/sessions/index.js";
import { schema, type Db } from "../db/index.js";
import { errorResponse, invalidQueryResponse } from "./errors.js";
import { viewCreateSchema, viewPatchSchema, type View } from "./schemas.js";
import { validate } from "./validator.js";

const { savedViews } = schema;

export interface ViewsOptions {
  db: Db;
}

const isUniqueViolation = (error: unknown): boolean => {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      return true;
    }
  }
  return false;
};

const duplicateName = (c: Context) =>
  errorResponse(c, 409, "conflict", "You already have a view with this name");

const viewNotFound = (c: Context) =>
  errorResponse(c, 404, "not_found", "Not found");

/** A blank filter means the default one, as it does for the list (SPEC FR-11). */
function invalidFilter(c: Context, filter: string) {
  const parsed = parse(filter.trim() === "" ? "is:open" : filter);
  if (!("error" in parsed)) {
    return null;
  }
  return invalidQueryResponse(c, parsed.error);
}

const toView = (row: typeof savedViews.$inferSelect): View => ({
  id: row.id,
  name: row.name,
  filter: row.filter,
  sort: row.sort as View["sort"],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The id of a path segment that is a positive integer, otherwise `null`. */
const viewId = (raw: string): number | null =>
  /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;

const byName = (a: View, b: View) => {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a.id - b.id;
};

/**
 * `GET`, `POST /api/views` and `PATCH`, `DELETE /api/views/:id` (SPEC FR-22,
 * §7.4): the session user's saved views. Every statement carries the session
 * user, so another user's view id is a `404` on every route (D-2). The
 * unique `(user_id, name)` constraint decides a duplicate name, so two
 * concurrent requests cannot both succeed.
 */
export function createViewRoutes({ db }: ViewsOptions) {
  return new Hono<SessionEnv>()
    .get("/views", (c) => {
      const { userId } = c.var.session;
      const items = db
        .select()
        .from(savedViews)
        .where(eq(savedViews.userId, userId))
        .all()
        .map(toView)
        .sort(byName);
      return c.json({ items });
    })
    .post("/views", validate("json", viewCreateSchema), (c) => {
      const { userId } = c.var.session;
      const { name, filter, sort } = c.req.valid("json");
      const problem = invalidFilter(c, filter);
      if (problem !== null) {
        return problem;
      }
      const now = Date.now();
      try {
        const row = db
          .insert(savedViews)
          .values({
            userId,
            name,
            filter: filter.trim(),
            sort,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        return c.json(toView(row), 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return duplicateName(c);
        }
        throw error;
      }
    })
    .patch("/views/:id", validate("json", viewPatchSchema), (c) => {
      const { userId } = c.var.session;
      const id = viewId(c.req.param("id"));
      if (id === null) {
        return viewNotFound(c);
      }
      const patch = c.req.valid("json");
      if (patch.filter !== undefined) {
        const problem = invalidFilter(c, patch.filter);
        if (problem !== null) {
          return problem;
        }
      }
      try {
        const row = db
          .update(savedViews)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.filter === undefined
              ? {}
              : { filter: patch.filter.trim() }),
            ...(patch.sort === undefined ? {} : { sort: patch.sort }),
            updatedAt: Date.now(),
          })
          .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
          .returning()
          .get();
        return row === undefined ? viewNotFound(c) : c.json(toView(row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return duplicateName(c);
        }
        throw error;
      }
    })
    .delete("/views/:id", (c) => {
      const { userId } = c.var.session;
      const id = viewId(c.req.param("id"));
      if (id === null) {
        return viewNotFound(c);
      }
      const row = db
        .delete(savedViews)
        .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
        .returning({ id: savedViews.id })
        .get();
      return row === undefined ? viewNotFound(c) : c.body(null, 204);
    });
}
