import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardListSchema, boardSchema } from "../src/api/schemas.js";
import { schema } from "../src/db/index.js";
import { ORIGIN, buildApiApp, jsonHeaders } from "./api-app.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { addUser, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-boards-"));
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

const columns = (...names: string[]) =>
  names.map((name) => ({ name, filter: `label:"status: ${name}"` }));

async function create(cookie: string, body: unknown) {
  const response = await request(cookie, "POST", "/api/boards", body);
  expect(response.status).toBe(201);
  return boardSchema.parse(await response.json());
}

async function list(cookie: string) {
  const response = await app().request("/api/boards", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return boardListSchema.parse(await response.json()).items;
}

const boardRows = () => database.db.select().from(schema.boards).all();
const columnRows = () => database.db.select().from(schema.boardColumns).all();

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

describe("/api/boards", () => {
  it.each([
    ["GET", "/api/boards"],
    ["POST", "/api/boards"],
    ["GET", "/api/boards/1"],
    ["PATCH", "/api/boards/1"],
    ["DELETE", "/api/boards/1"],
  ])("rejects %s %s without a session", async (method, path) => {
    const response = await app().request(path, {
      method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
    });
    expect(response.status).toBe(401);
  });

  it("creates a board with its columns in order and reads it back", async () => {
    const { aliceCookie } = twoUsers();
    expect(await list(aliceCookie)).toEqual([]);

    const board = await create(aliceCookie, {
      name: "  Sprint  ",
      baseFilter: " repo:acme/api ",
      columns: [
        { name: " Todo ", filter: " label:todo " },
        { name: "Doing", filter: "label:doing" },
        { name: "Done", filter: "" },
      ],
      sort: "title-asc",
      subIssueMode: "expanded",
      showOther: true,
    });

    expect(board).toMatchObject({
      name: "Sprint",
      baseFilter: "repo:acme/api",
      sort: "title-asc",
      subIssueMode: "expanded",
      showOther: true,
    });
    expect(board.columns.map(({ name, filter }) => ({ name, filter }))).toEqual(
      [
        { name: "Todo", filter: "label:todo" },
        { name: "Doing", filter: "label:doing" },
        { name: "Done", filter: "" },
      ],
    );
    expect(board.createdAt).toBe(board.updatedAt);
    expect(await list(aliceCookie)).toEqual([board]);

    const got = await app().request(`/api/boards/${String(board.id)}`, {
      headers: { Cookie: aliceCookie },
    });
    expect(got.status).toBe(200);
    expect(boardSchema.parse(await got.json())).toEqual(board);
    expect(columnRows().map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it("defaults the base filter, sort, sub-issue mode and the Other toggle", async () => {
    const { aliceCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "Plain",
      columns: columns("a"),
    });
    expect(board).toMatchObject({
      baseFilter: "",
      sort: "updated-desc",
      subIssueMode: "collapsed",
      showOther: false,
    });
  });

  it("lists the boards by name and allows equal names", async () => {
    const { aliceCookie } = twoUsers();
    await create(aliceCookie, { name: "zeta", columns: columns("a") });
    await create(aliceCookie, { name: "Alpha", columns: columns("a") });
    const first = await create(aliceCookie, {
      name: "Same",
      columns: columns("a", "b"),
    });
    const second = await create(aliceCookie, {
      name: "Same",
      columns: columns("c"),
    });

    const items = await list(aliceCookie);
    expect(items.map((board) => board.name)).toEqual([
      "Alpha",
      "Same",
      "Same",
      "zeta",
    ]);
    expect(items.map((board) => board.id).slice(1, 3)).toEqual([
      first.id,
      second.id,
    ]);
    expect(items[1]?.columns).toHaveLength(2);
    expect(items[2]?.columns).toHaveLength(1);
  });

  it("accepts names and column names of 1 to 100 characters only", async () => {
    const { aliceCookie } = twoUsers();
    await create(aliceCookie, {
      name: "a".repeat(100),
      columns: [{ name: "b".repeat(100) }],
    });

    for (const name of ["", "   ", "c".repeat(101)]) {
      const asBoard = await request(aliceCookie, "POST", "/api/boards", {
        name,
        columns: columns("x"),
      });
      expect(asBoard.status, `board ${JSON.stringify(name)}`).toBe(400);
      const asColumn = await request(aliceCookie, "POST", "/api/boards", {
        name: "ok",
        columns: [{ name, filter: "" }],
      });
      expect(asColumn.status, `column ${JSON.stringify(name)}`).toBe(400);
    }
    expect(boardRows()).toHaveLength(1);
  });

  it("accepts 1 to 20 columns only", async () => {
    const { aliceCookie } = twoUsers();
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `c${String(index)}`,
      }));
    const twenty = await create(aliceCookie, {
      name: "max",
      columns: many(20),
    });
    expect(twenty.columns).toHaveLength(20);

    for (const count of [0, 21]) {
      const response = await request(aliceCookie, "POST", "/api/boards", {
        name: "bad",
        columns: many(count),
      });
      expect(response.status, String(count)).toBe(400);
    }
    const none = await request(aliceCookie, "POST", "/api/boards", {
      name: "bad",
    });
    expect(none.status).toBe(400);
    const patched = await request(
      aliceCookie,
      "PATCH",
      `/api/boards/${String(twenty.id)}`,
      {
        columns: many(21),
      },
    );
    expect(patched.status).toBe(400);
    expect(boardRows()).toHaveLength(1);
    expect(columnRows()).toHaveLength(20);
  });

  it("rejects a sort, a sub-issue mode or a toggle of the wrong kind", async () => {
    const { aliceCookie } = twoUsers();
    const bodies = [
      { sort: "popularity-desc" },
      { subIssueMode: "nested" },
      { showOther: "yes" },
    ];
    for (const extra of bodies) {
      const response = await request(aliceCookie, "POST", "/api/boards", {
        name: "x",
        columns: columns("a"),
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(boardRows()).toEqual([]);
  });

  it("answers 400 naming the base filter or the column of an invalid filter, and stores nothing", async () => {
    const { aliceCookie } = twoUsers();

    const column = await request(aliceCookie, "POST", "/api/boards", {
      name: "broken",
      columns: [
        { name: "Fine", filter: "is:open" },
        { name: "Broken", filter: "is:open AND" },
      ],
    });
    expect(column.status).toBe(400);
    expect(await column.json()).toEqual({
      error: {
        code: "invalid_query",
        message: 'Column 2 "Broken": AND must be between two terms',
        start: 8,
        end: 11,
        field: "columns.1.filter",
      },
    });

    const base = await request(aliceCookie, "POST", "/api/boards", {
      name: "broken",
      baseFilter: 'label:"unbalanced',
      columns: columns("a"),
    });
    expect(base.status).toBe(400);
    const body = (await base.json()) as {
      error: { code: string; message: string; field: string };
    };
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.message).toMatch(/^Base filter: /);
    expect(body.error.field).toBe("baseFilter");
    expect(boardRows()).toEqual([]);
    expect(columnRows()).toEqual([]);
  });

  it("updates a board's fields and leaves the others and the columns alone", async () => {
    const { aliceCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "Old",
      baseFilter: "repo:acme/api",
      columns: columns("a", "b"),
    });
    const path = `/api/boards/${String(board.id)}`;

    const response = await request(aliceCookie, "PATCH", path, {
      name: "New",
      sort: "repo-asc",
      subIssueMode: "expanded",
      showOther: true,
    });

    expect(response.status).toBe(200);
    const updated = boardSchema.parse(await response.json());
    expect(updated).toMatchObject({
      id: board.id,
      name: "New",
      baseFilter: "repo:acme/api",
      sort: "repo-asc",
      subIssueMode: "expanded",
      showOther: true,
      createdAt: board.createdAt,
    });
    expect(updated.columns).toEqual(board.columns);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(board.updatedAt);

    const cleared = await request(aliceCookie, "PATCH", path, {
      baseFilter: "",
      showOther: false,
    });
    expect(boardSchema.parse(await cleared.json())).toMatchObject({
      baseFilter: "",
      showOther: false,
    });
  });

  it("replaces the columns in the order sent", async () => {
    const { aliceCookie, bobCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "B",
      columns: columns("a", "b", "c"),
    });
    const other = await create(bobCookie, {
      name: "Other",
      columns: columns("x", "y"),
    });

    const response = await request(
      aliceCookie,
      "PATCH",
      `/api/boards/${String(board.id)}`,
      {
        columns: [
          { name: "c", filter: "label:c" },
          { name: "z", filter: "is:blocked" },
        ],
      },
    );

    expect(response.status).toBe(200);
    const updated = boardSchema.parse(await response.json());
    expect(
      updated.columns.map(({ name, filter }) => ({ name, filter })),
    ).toEqual([
      { name: "c", filter: "label:c" },
      { name: "z", filter: "is:blocked" },
    ]);
    expect(columnRows().filter((row) => row.boardId === board.id)).toHaveLength(
      2,
    );
    expect((await list(bobCookie))[0]?.columns).toEqual(other.columns);
  });

  it("keeps the board unchanged when a patch has an invalid filter", async () => {
    const { aliceCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "Keep",
      columns: columns("a", "b"),
    });
    const path = `/api/boards/${String(board.id)}`;

    const response = await request(aliceCookie, "PATCH", path, {
      name: "Changed",
      columns: [{ name: "Bad", filter: "label:" + '"open' }],
    });

    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message,
    ).toMatch(/^Column 1 "Bad": /);
    const stored = await app().request(path, {
      headers: { Cookie: aliceCookie },
    });
    expect(boardSchema.parse(await stored.json())).toEqual(board);
  });

  it("answers 400 for a body that changes nothing or is not JSON", async () => {
    const { aliceCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "v",
      columns: columns("a"),
    });

    expect(
      (
        await request(
          aliceCookie,
          "PATCH",
          `/api/boards/${String(board.id)}`,
          {},
        )
      ).status,
    ).toBe(400);
    expect((await request(aliceCookie, "POST", "/api/boards", {})).status).toBe(
      400,
    );
    const malformed = await app().request("/api/boards", {
      method: "POST",
      headers: jsonHeaders(aliceCookie),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("deletes a board with its columns and nothing else", async () => {
    const { aliceCookie } = twoUsers();
    const gone = await create(aliceCookie, {
      name: "Gone",
      columns: columns("a", "b"),
    });
    const kept = await create(aliceCookie, {
      name: "Kept",
      columns: columns("c"),
    });

    const response = await request(
      aliceCookie,
      "DELETE",
      `/api/boards/${String(gone.id)}`,
    );

    expect(response.status).toBe(204);
    expect((await list(aliceCookie)).map((board) => board.id)).toEqual([
      kept.id,
    ]);
    expect(columnRows().map((row) => row.boardId)).toEqual([kept.id]);
  });

  it("keeps boards personal: another user's id is a 404 on every route", async () => {
    const { alice, aliceCookie, bobCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "Private",
      baseFilter: "label:bug",
      columns: columns("a", "b"),
    });
    const path = `/api/boards/${String(board.id)}`;
    await create(bobCookie, { name: "Bob's", columns: columns("x") });

    expect((await list(bobCookie)).map((entry) => entry.name)).toEqual([
      "Bob's",
    ]);
    const notFound = { error: { code: "not_found", message: "Not found" } };

    const got = await app().request(path, { headers: { Cookie: bobCookie } });
    expect(got.status).toBe(404);
    expect(await got.json()).toEqual(notFound);
    const patched = await request(bobCookie, "PATCH", path, {
      name: "Hijacked",
      columns: columns("evil"),
    });
    expect(patched.status).toBe(404);
    expect(await patched.json()).toEqual(notFound);
    const deleted = await request(bobCookie, "DELETE", path);
    expect(deleted.status).toBe(404);

    const mine = boardRows().filter((row) => row.userId === alice.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "Private", baseFilter: "label:bug" });
    expect(columnRows().filter((row) => row.boardId === board.id)).toHaveLength(
      2,
    );
    expect(
      boardSchema.parse(
        await (
          await app().request(path, { headers: { Cookie: aliceCookie } })
        ).json(),
      ),
    ).toEqual(board);
  });

  it("answers 404 for an id that does not exist or is not a number", async () => {
    const { aliceCookie } = twoUsers();
    for (const id of ["999", "0", "abc", "1.5", "-1"]) {
      const got = await app().request(`/api/boards/${id}`, {
        headers: { Cookie: aliceCookie },
      });
      expect(got.status, `GET ${id}`).toBe(404);
      const patched = await request(aliceCookie, "PATCH", `/api/boards/${id}`, {
        name: "x",
      });
      expect(patched.status, `PATCH ${id}`).toBe(404);
      const deleted = await request(aliceCookie, "DELETE", `/api/boards/${id}`);
      expect(deleted.status, `DELETE ${id}`).toBe(404);
    }
  });

  it("is removed with its user", async () => {
    const { alice, aliceCookie } = twoUsers();
    await create(aliceCookie, {
      name: "Gone with the user",
      columns: columns("a"),
    });
    database.db.delete(schema.users).where(eq(schema.users.id, alice.id)).run();
    expect(boardRows()).toEqual([]);
    expect(columnRows()).toEqual([]);
  });
});

describe("the CSRF guard on /api/boards", () => {
  it("rejects a POST without an Origin and writes no row", async () => {
    const { aliceCookie } = twoUsers();

    const response = await app().request("/api/boards", {
      method: "POST",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "csrf", columns: columns("a") }),
    });

    expect(response.status).toBe(403);
    expect(boardRows()).toEqual([]);
  });

  it("rejects a foreign Origin and a non-JSON body without a change", async () => {
    const { aliceCookie } = twoUsers();
    const board = await create(aliceCookie, {
      name: "kept",
      columns: columns("a"),
    });
    const path = `/api/boards/${String(board.id)}`;

    const foreign = await app().request(path, {
      method: "PATCH",
      headers: {
        Cookie: aliceCookie,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "changed" }),
    });
    const text = await app().request("/api/boards", {
      method: "POST",
      headers: {
        Cookie: aliceCookie,
        Origin: ORIGIN,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ name: "plain", columns: columns("a") }),
    });
    const noOrigin = await app().request(path, {
      method: "DELETE",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
    });

    expect(foreign.status).toBe(403);
    expect(text.status).toBe(415);
    expect(noOrigin.status).toBe(403);
    expect(boardRows().map((row) => row.name)).toEqual(["kept"]);
  });
});
