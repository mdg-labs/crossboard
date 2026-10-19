import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { viewListSchema, viewSchema } from "../src/api/schemas.js";
import { schema } from "../src/db/index.js";
import { ORIGIN, buildApiApp, jsonHeaders } from "./api-app.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { addUser, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-views-"));
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const app = () => buildApiApp(database, dir);

function request(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app().request(path, {
      method,
      headers: jsonHeaders(cookie),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function create(cookie: string, body: unknown) {
  const response = await request(cookie, "POST", "/api/views", body);
  expect(response.status).toBe(201);
  return viewSchema.parse(await response.json());
}

async function list(cookie: string) {
  const response = await app().request("/api/views", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return viewListSchema.parse(await response.json()).items;
}

const rows = () => database.db.select().from(schema.savedViews).all();

function twoUsers() {
  const alice = addUser(database.db, "octocat");
  const bob = addUser(database.db, "bobby");
  return {
    alice,
    bob,
    aliceCookie: signIn(database.db, alice.id).cookie,
    bobCookie: signIn(database.db, bob.id).cookie,
  };
}

describe("/api/views", () => {
  it.each([
    ["GET", "/api/views"],
    ["POST", "/api/views"],
    ["PATCH", "/api/views/1"],
    ["DELETE", "/api/views/1"],
  ])("rejects %s %s without a session", async (method, path) => {
    const response = await app().request(path, {
      method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    expect(response.status).toBe(401);
  });

  it("creates, lists, renames, re-filters and deletes a view", async () => {
    const { aliceCookie } = twoUsers();
    expect(await list(aliceCookie)).toEqual([]);

    const view = await create(aliceCookie, {
      name: "  My bugs  ",
      filter: " label:bug assignee:@me ",
      sort: "title-asc",
    });
    expect(view).toMatchObject({
      name: "My bugs",
      filter: "label:bug assignee:@me",
      sort: "title-asc",
    });
    expect(view.createdAt).toBe(view.updatedAt);
    expect(await list(aliceCookie)).toEqual([view]);

    const renamed = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(view.id)}`,
      { name: "Bugs" },
    );
    expect(renamed.status).toBe(200);
    expect(viewSchema.parse(await renamed.json())).toMatchObject({
      id: view.id,
      name: "Bugs",
      filter: "label:bug assignee:@me",
      sort: "title-asc",
    });

    const changed = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(view.id)}`,
      { filter: "is:blocked", sort: "repo-asc" },
    );
    expect(viewSchema.parse(await changed.json())).toMatchObject({
      name: "Bugs",
      filter: "is:blocked",
      sort: "repo-asc",
    });

    const removed = await request(
      aliceCookie,
      "DELETE",
      `/api/views/${String(view.id)}`,
    );
    expect(removed.status).toBe(204);
    expect(await list(aliceCookie)).toEqual([]);
  });

  it("defaults the filter and sort, and lists the views by name", async () => {
    const { aliceCookie } = twoUsers();
    const plain = await create(aliceCookie, { name: "zeta" });
    await create(aliceCookie, { name: "Alpha" });
    await create(aliceCookie, { name: "beta" });

    expect(plain).toMatchObject({ filter: "", sort: "updated-desc" });
    expect((await list(aliceCookie)).map((view) => view.name)).toEqual([
      "Alpha",
      "beta",
      "zeta",
    ]);
  });

  it("accepts names of 1 to 100 characters only", async () => {
    const { aliceCookie } = twoUsers();
    await create(aliceCookie, { name: "a" });
    await create(aliceCookie, { name: "b".repeat(100) });

    for (const name of ["", "   ", "c".repeat(101)]) {
      const response = await request(aliceCookie, "POST", "/api/views", {
        name,
      });
      expect(response.status, JSON.stringify(name)).toBe(400);
    }
    const view = await create(aliceCookie, { name: "ok" });
    const tooLong = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(view.id)}`,
      { name: "d".repeat(101) },
    );
    expect(tooLong.status).toBe(400);
    expect(rows()).toHaveLength(3);
  });

  it("rejects a sort that is not one of the list's options", async () => {
    const { aliceCookie } = twoUsers();
    const bad = await request(aliceCookie, "POST", "/api/views", {
      name: "x",
      sort: "popularity-desc",
    });
    expect(bad.status).toBe(400);
    const view = await create(aliceCookie, { name: "y" });
    const patched = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(view.id)}`,
      { sort: "sort:updated" },
    );
    expect(patched.status).toBe(400);
    expect(rows().map((row) => row.sort)).toEqual(["updated-desc"]);
  });

  it("answers 400 with the parse error for an invalid filter and stores nothing", async () => {
    const { aliceCookie } = twoUsers();

    const response = await request(aliceCookie, "POST", "/api/views", {
      name: "broken",
      filter: "is:open AND",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_query",
        message: "AND must be between two terms",
        start: 8,
        end: 11,
      },
    });
    expect(rows()).toEqual([]);

    const view = await create(aliceCookie, { name: "fine", filter: "is:open" });
    const patched = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(view.id)}`,
      { filter: 'label:"unbalanced' },
    );
    expect(patched.status).toBe(400);
    expect(
      ((await patched.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_query");
    expect(rows().map((row) => row.filter)).toEqual(["is:open"]);
  });

  it("accepts a blank filter as the default one", async () => {
    const { aliceCookie } = twoUsers();
    const view = await create(aliceCookie, { name: "all", filter: "   " });
    expect(view.filter).toBe("");
  });

  it("answers 400 for a body that changes nothing or is not an object", async () => {
    const { aliceCookie } = twoUsers();
    const view = await create(aliceCookie, { name: "v" });
    const path = `/api/views/${String(view.id)}`;

    expect((await request(aliceCookie, "PATCH", path, {})).status).toBe(400);
    expect((await request(aliceCookie, "POST", "/api/views", {})).status).toBe(
      400,
    );
    const malformed = await app().request("/api/views", {
      method: "POST",
      headers: jsonHeaders(aliceCookie),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("answers 409 for a duplicate name, on create and on rename", async () => {
    const { aliceCookie } = twoUsers();
    await create(aliceCookie, { name: "Mine" });
    const other = await create(aliceCookie, { name: "Other" });

    const duplicate = await request(aliceCookie, "POST", "/api/views", {
      name: " Mine ",
    });
    expect(duplicate.status).toBe(409);
    expect(
      ((await duplicate.json()) as { error: { code: string } }).error.code,
    ).toBe("conflict");

    const rename = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(other.id)}`,
      { name: "Mine" },
    );
    expect(rename.status).toBe(409);
    expect(
      rows()
        .map((row) => row.name)
        .sort(),
    ).toEqual(["Mine", "Other"]);

    const same = await request(
      aliceCookie,
      "PATCH",
      `/api/views/${String(other.id)}`,
      { name: "Other", sort: "title-asc" },
    );
    expect(same.status).toBe(200);
  });

  it("answers 409, not 500, when two creates with one name race", async () => {
    const { aliceCookie } = twoUsers();

    const answers = await Promise.all([
      request(aliceCookie, "POST", "/api/views", { name: "Race" }),
      request(aliceCookie, "POST", "/api/views", { name: "Race" }),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(rows()).toHaveLength(1);
  });

  it("lets two users use the same view name", async () => {
    const { aliceCookie, bobCookie } = twoUsers();
    await create(aliceCookie, { name: "Same" });
    await create(bobCookie, { name: "Same" });
    expect(rows()).toHaveLength(2);
  });

  it("keeps views personal: another user's id is a 404 on every route", async () => {
    const { alice, aliceCookie, bobCookie } = twoUsers();
    const view = await create(aliceCookie, {
      name: "Private",
      filter: "label:bug",
    });
    const path = `/api/views/${String(view.id)}`;
    await create(bobCookie, { name: "Bob's" });

    expect((await list(bobCookie)).map((entry) => entry.name)).toEqual([
      "Bob's",
    ]);
    const patched = await request(bobCookie, "PATCH", path, {
      name: "Hijacked",
      filter: "is:open",
    });
    expect(patched.status).toBe(404);
    expect(await patched.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
    const deleted = await request(bobCookie, "DELETE", path);
    expect(deleted.status).toBe(404);

    const mine = rows().filter((row) => row.userId === alice.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "Private", filter: "label:bug" });
  });

  it("answers 404 for an id that does not exist or is not a number", async () => {
    const { aliceCookie } = twoUsers();
    for (const id of ["999", "0", "abc", "1.5", "-1"]) {
      const patched = await request(aliceCookie, "PATCH", `/api/views/${id}`, {
        name: "x",
      });
      expect(patched.status, `PATCH ${id}`).toBe(404);
      const deleted = await request(aliceCookie, "DELETE", `/api/views/${id}`);
      expect(deleted.status, `DELETE ${id}`).toBe(404);
    }
  });

  it("is removed with its user", async () => {
    const { alice, aliceCookie } = twoUsers();
    await create(aliceCookie, { name: "Gone with the user" });
    database.db.delete(schema.users).where(eq(schema.users.id, alice.id)).run();
    expect(rows()).toEqual([]);
  });
});

describe("the CSRF guard on /api/views", () => {
  it("rejects a POST without an Origin and writes no row", async () => {
    const { aliceCookie } = twoUsers();

    const response = await app().request("/api/views", {
      method: "POST",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "csrf" }),
    });

    expect(response.status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it("rejects a foreign Origin and a non-JSON body without a change", async () => {
    const { aliceCookie } = twoUsers();
    const view = await create(aliceCookie, { name: "kept" });
    const path = `/api/views/${String(view.id)}`;

    const foreign = await app().request(path, {
      method: "PATCH",
      headers: {
        Cookie: aliceCookie,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "changed" }),
    });
    const text = await app().request("/api/views", {
      method: "POST",
      headers: {
        Cookie: aliceCookie,
        Origin: ORIGIN,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ name: "plain" }),
    });
    const noOrigin = await app().request(path, {
      method: "DELETE",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
    });

    expect(foreign.status).toBe(403);
    expect(text.status).toBe(415);
    expect(noOrigin.status).toBe(403);
    expect(rows().map((row) => row.name)).toEqual(["kept"]);
  });
});
