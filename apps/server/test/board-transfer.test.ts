import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_FILE_MAX_BYTES } from "../src/api/boards-transfer.js";
import { boardSchema } from "../src/api/schemas.js";
import { schema } from "../src/db/index.js";
import { ORIGIN, buildApiApp, jsonHeaders } from "./api-app.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { addUser, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-board-transfer-"));
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const app = () => buildApiApp(database, dir);

const send = (cookie: string, method: string, path: string, body?: string) =>
  Promise.resolve(
    app().request(path, {
      method,
      headers: jsonHeaders(cookie),
      ...(body === undefined ? {} : { body }),
    }),
  );

const importFile = (cookie: string, file: unknown) =>
  send(
    cookie,
    "POST",
    "/api/boards/import",
    typeof file === "string" ? file : JSON.stringify(file),
  );

const boardRows = () => database.db.select().from(schema.boards).all();
const columnRows = () => database.db.select().from(schema.boardColumns).all();

const validFile = {
  crossboard: "board",
  version: 1,
  name: "Sprint",
  baseFilter: "repo:acme/api",
  sort: "title-asc",
  subIssueMode: "expanded",
  showOther: true,
  columns: [
    { name: "Todo", filter: "label:todo" },
    { name: "Doing", filter: "label:doing" },
    { name: "Done", filter: "" },
  ],
};

async function message(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

function twoUsers() {
  const alice = addUser(database.db, "octocat");
  const bob = addUser(database.db, "bobby");
  return {
    aliceCookie: signIn(database.db, alice.id).cookie,
    bobCookie: signIn(database.db, bob.id).cookie,
  };
}

describe("GET /api/boards/:id/export", () => {
  it("returns the board in the FR-36 format, without ids", async () => {
    const { aliceCookie } = twoUsers();
    const imported = await importFile(aliceCookie, validFile);
    const board = boardSchema.parse(await imported.json());

    const response = await app().request(
      `/api/boards/${String(board.id)}/export`,
      { headers: { Cookie: aliceCookie } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await response.json()).toStrictEqual(validFile);
  });

  it("answers 404 for another user's board, a missing one and a bad id", async () => {
    const { aliceCookie, bobCookie } = twoUsers();
    const created = await importFile(aliceCookie, validFile);
    const board = boardSchema.parse(await created.json());

    for (const [cookie, id] of [
      [bobCookie, String(board.id)],
      [aliceCookie, "9999"],
      [aliceCookie, "abc"],
    ] as const) {
      const response = await app().request(`/api/boards/${id}/export`, {
        headers: { Cookie: cookie },
      });
      expect(response.status, id).toBe(404);
    }
  });

  it("requires a session", async () => {
    const response = await app().request("/api/boards/1/export");
    expect(response.status).toBe(401);
  });
});

describe("POST /api/boards/import", () => {
  it("creates a new board with its columns in order", async () => {
    const { aliceCookie } = twoUsers();

    const response = await importFile(aliceCookie, validFile);

    expect(response.status).toBe(201);
    const board = boardSchema.parse(await response.json());
    expect(board).toMatchObject({
      name: "Sprint",
      baseFilter: "repo:acme/api",
      sort: "title-asc",
      subIssueMode: "expanded",
      showOther: true,
    });
    expect(board.columns.map((column) => column.name)).toEqual([
      "Todo",
      "Doing",
      "Done",
    ]);
    expect(boardRows()).toHaveLength(1);
    expect(columnRows().map((row) => row.position)).toEqual([0, 1, 2]);
  });

  it("owns the board by the session user", async () => {
    const { aliceCookie, bobCookie } = twoUsers();
    const created = await importFile(aliceCookie, validFile);
    const board = boardSchema.parse(await created.json());

    const bobs = await app().request("/api/boards", {
      headers: { Cookie: bobCookie },
    });
    expect(await bobs.json()).toEqual({ items: [] });
    expect(boardRows().map((row) => row.id)).toEqual([board.id]);
  });

  it("never overwrites: importing twice, even under one name, adds a board each time", async () => {
    const { aliceCookie } = twoUsers();
    const first = boardSchema.parse(
      await (await importFile(aliceCookie, validFile)).json(),
    );
    const second = boardSchema.parse(
      await (await importFile(aliceCookie, validFile)).json(),
    );

    expect(second.id).not.toBe(first.id);
    expect(boardRows()).toHaveLength(2);
    expect(columnRows()).toHaveLength(6);
  });

  it("yields an equal board when an export is imported again", async () => {
    const { aliceCookie } = twoUsers();
    const original = boardSchema.parse(
      await (await importFile(aliceCookie, validFile)).json(),
    );
    const exported = await app().request(
      `/api/boards/${String(original.id)}/export`,
      { headers: { Cookie: aliceCookie } },
    );

    const again = boardSchema.parse(
      await (await importFile(aliceCookie, await exported.text())).json(),
    );

    const content = (board: typeof original) => ({
      ...board,
      id: 0,
      createdAt: 0,
      updatedAt: 0,
      columns: board.columns.map(({ name, filter }) => ({ name, filter })),
    });
    expect(again.id).not.toBe(original.id);
    expect(content(again)).toEqual(content(original));
  });

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["an array", "[]", "JSON object"],
    ["a null", "null", "JSON object"],
    [
      "another kind of file",
      { ...validFile, crossboard: "view" },
      "crossboard",
    ],
    ["version 2", { ...validFile, version: 2 }, "version"],
    ["a string version", { ...validFile, version: "1" }, "version"],
    ["no version", { ...validFile, version: undefined }, "version"],
    ["an empty name", { ...validFile, name: " " }, "name"],
    ["a long name", { ...validFile, name: "x".repeat(101) }, "name"],
    ["an unknown sort", { ...validFile, sort: "random" }, "sort"],
    [
      "an unknown sub-issue mode",
      { ...validFile, subIssueMode: "nested" },
      "subIssueMode",
    ],
    ["a non-boolean toggle", { ...validFile, showOther: "yes" }, "showOther"],
    ["no columns", { ...validFile, columns: [] }, "columns"],
    [
      "21 columns",
      {
        ...validFile,
        columns: Array.from({ length: 21 }, (_, i) => ({
          name: `c${String(i)}`,
          filter: "",
        })),
      },
      "columns",
    ],
    [
      "a column without a name",
      { ...validFile, columns: [{ filter: "" }] },
      "columns.0.name",
    ],
  ])("answers 400 for %s", async (_label, file, fragment) => {
    const { aliceCookie } = twoUsers();

    const response = await importFile(aliceCookie, file);

    expect(response.status).toBe(400);
    expect(await message(response)).toContain(fragment);
    expect(boardRows()).toHaveLength(0);
  });

  it("names the first problem when several are wrong", async () => {
    const { aliceCookie } = twoUsers();
    const response = await importFile(aliceCookie, {
      ...validFile,
      version: 2,
      name: "",
    });
    expect(await message(response)).toContain("version");
  });

  it("answers 400 for a filter that does not parse and creates nothing", async () => {
    const { aliceCookie } = twoUsers();
    for (const [file, field] of [
      [{ ...validFile, baseFilter: "label:(" }, "baseFilter"],
      [
        {
          ...validFile,
          columns: [
            { name: "ok", filter: "is:open" },
            { name: "bad", filter: "label:(" },
          ],
        },
        "columns.1.filter",
      ],
    ] as const) {
      const response = await importFile(aliceCookie, file);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; field: string };
      };
      expect(body.error).toMatchObject({ code: "invalid_query", field });
    }
    expect(boardRows()).toHaveLength(0);
    expect(columnRows()).toHaveLength(0);
  });

  it("accepts a file of exactly 256 KB and refuses a larger one before parsing", async () => {
    const { aliceCookie } = twoUsers();
    const shell = JSON.stringify({ ...validFile, baseFilter: "" });
    const padding = " ".repeat(BOARD_FILE_MAX_BYTES - shell.length);
    const atLimit = await importFile(aliceCookie, shell + padding);
    expect(atLimit.status).toBe(201);

    const over = await importFile(aliceCookie, shell + padding + " ");
    expect(over.status).toBe(413);
    const unparsable = await importFile(
      aliceCookie,
      "{".repeat(BOARD_FILE_MAX_BYTES + 1),
    );
    expect(unparsable.status).toBe(413);
    expect(boardRows()).toHaveLength(1);
  });

  it("rejects a missing Origin and a non-JSON body, and needs a session", async () => {
    const { aliceCookie } = twoUsers();
    const body = JSON.stringify(validFile);

    const foreign = await app().request("/api/boards/import", {
      method: "POST",
      headers: { ...jsonHeaders(aliceCookie), Origin: "https://evil.example" },
      body,
    });
    const text = await app().request("/api/boards/import", {
      method: "POST",
      headers: { ...jsonHeaders(aliceCookie), "Content-Type": "text/plain" },
      body,
    });
    const anonymous = await app().request("/api/boards/import", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body,
    });

    expect(foreign.status).toBe(403);
    expect(text.status).toBe(415);
    expect(anonymous.status).toBe(401);
    expect(boardRows()).toHaveLength(0);
  });
});
