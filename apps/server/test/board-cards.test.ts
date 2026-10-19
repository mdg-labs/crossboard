import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardSchema } from "../src/api/schemas.js";
import {
  boardCardsSchema,
  type BoardCard,
  type BoardCards,
} from "../src/boards/index.js";
import { schema } from "../src/db/index.js";
import {
  addInstallation,
  addRepo,
  buildApiApp,
  jsonHeaders,
} from "./api-app.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { addUser, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-board-cards-"));
  addInstallation(database);
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const app = () => buildApiApp(database, dir);

interface IssueSeed {
  number: number;
  label?: string;
  parent?: { id: string; repo: string; number: number };
  updatedAt?: number;
}

/** An open issue whose id is `<repo>#<number>`, and its ref row for children to name. */
function addIssue(repoId: string, fullName: string, seed: IssueSeed): string {
  const id = `${fullName}#${String(seed.number)}`;
  database.db
    .insert(schema.issues)
    .values({
      id,
      databaseId: Math.floor(Math.random() * 1e9),
      repoId,
      number: seed.number,
      title: `Issue ${String(seed.number)}`,
      url: `https://github.com/${fullName}/issues/${String(seed.number)}`,
      authorLogin: "alice",
      parentId: seed.parent?.id ?? null,
      subTotal: 0,
      subCompleted: 0,
      blockedByTotal: 0,
      blockingTotal: 0,
      createdAt: 1000,
      updatedAt: seed.updatedAt ?? 1000,
      syncedAt: 1,
    })
    .run();
  database.db
    .insert(schema.issueRefs)
    .values({
      id,
      repoFullName: fullName,
      number: seed.number,
      title: `Issue ${String(seed.number)}`,
      state: "OPEN",
      url: `https://github.com/${fullName}/issues/${String(seed.number)}`,
      seenAt: 1,
    })
    .run();
  if (seed.label !== undefined) {
    const labelId = `${repoId}:${seed.label}`;
    database.db
      .insert(schema.labels)
      .values({
        id: labelId,
        repoId,
        name: seed.label,
        color: "ffffff",
        description: null,
      })
      .onConflictDoNothing()
      .run();
    database.db
      .insert(schema.issueLabels)
      .values({ issueId: id, labelId })
      .run();
  }
  return id;
}

/** A ref to an issue that is not synced. */
function addUnsyncedRef(fullName: string, number: number): string {
  const id = `${fullName}#${String(number)}`;
  database.db
    .insert(schema.issueRefs)
    .values({
      id,
      repoFullName: fullName,
      number,
      title: "Not synced",
      state: "OPEN",
      url: `https://github.com/${fullName}/issues/${String(number)}`,
      seenAt: 1,
    })
    .run();
  return id;
}

async function createBoard(cookie: string, body: Record<string, unknown>) {
  const response = await app().request("/api/boards", {
    method: "POST",
    headers: jsonHeaders(cookie),
    body: JSON.stringify({
      name: "Board",
      columns: [
        { name: "Todo", filter: "label:todo" },
        { name: "Doing", filter: "label:doing" },
      ],
      ...body,
    }),
  });
  expect(response.status).toBe(201);
  return boardSchema.parse(await response.json());
}

const cards = (cookie: string, boardId: number | string, query = "") =>
  app().request(`/api/boards/${String(boardId)}/cards${query}`, {
    headers: { Cookie: cookie },
  });

async function cardsBody(
  cookie: string,
  boardId: number,
  query = "",
): Promise<BoardCards & { warnings: unknown[] }> {
  const response = await cards(cookie, boardId, query);
  expect(response.status).toBe(200);
  return boardCardsSchema.parse(await response.json());
}

const numbers = (list: readonly BoardCard[] | undefined) =>
  (list ?? []).map((card) => card.number);

function oneUser() {
  const alice = addUser(database.db, "octocat");
  return {
    alice,
    cookie: signIn(database.db, alice.id).cookie,
    repo: addRepo(database, "acme", "web", [alice.id]),
  };
}

describe("GET /api/boards/:id/cards", () => {
  it("rejects a request without a session", async () => {
    expect((await app().request("/api/boards/1/cards")).status).toBe(401);
  });

  it("answers 404 for another user's board, an unknown board and a malformed id", async () => {
    const { cookie } = oneUser();
    const bob = addUser(database.db, "bobby");
    const bobCookie = signIn(database.db, bob.id).cookie;
    const board = await createBoard(cookie, {});

    expect((await cards(bobCookie, board.id)).status).toBe(404);
    expect((await cards(cookie, board.id + 100)).status).toBe(404);
    expect((await cards(cookie, "abc")).status).toBe(404);
    expect((await cards(cookie, board.id)).status).toBe(200);
  });

  it("places each issue in the first matching column and counts top-level cards", async () => {
    const { cookie, repo } = oneUser();
    addIssue(repo, "acme/web", { number: 1, label: "todo" });
    addIssue(repo, "acme/web", { number: 2, label: "doing" });
    addIssue(repo, "acme/web", { number: 3, label: "todo" });
    const both = addIssue(repo, "acme/web", { number: 4, label: "doing" });
    database.db
      .insert(schema.issueLabels)
      .values({ issueId: both, labelId: `${repo}:todo` })
      .run();
    addIssue(repo, "acme/web", { number: 5 });
    const board = await createBoard(cookie, { sort: "repo-asc" });

    const body = await cardsBody(cookie, board.id);

    expect(body.columns.map((column) => column.name)).toEqual([
      "Todo",
      "Doing",
    ]);
    expect(body.columns.map((column) => column.id)).toEqual(
      board.columns.map((column) => column.id),
    );
    expect(numbers(body.columns[0]?.cards)).toEqual([1, 3, 4]);
    expect(body.columns[0]?.count).toBe(3);
    expect(numbers(body.columns[1]?.cards)).toEqual([2]);
    expect(body.columns[1]?.count).toBe(1);
    expect(body.other).toBeUndefined();
    expect(body.warnings).toEqual([]);
  });

  it("places an issue no column matches in Other only when the board shows it", async () => {
    const { cookie, repo } = oneUser();
    addIssue(repo, "acme/web", { number: 1, label: "todo" });
    addIssue(repo, "acme/web", { number: 2 });
    const hidden = await createBoard(cookie, {});
    const shown = await createBoard(cookie, { showOther: true });

    expect((await cardsBody(cookie, hidden.id)).other).toBeUndefined();
    const body = await cardsBody(cookie, shown.id);
    expect(body.other?.count).toBe(1);
    expect(numbers(body.other?.cards)).toEqual([2]);
  });

  it("narrows by the base filter and by the ad-hoc q, and answers 400 for a bad q", async () => {
    const { alice, cookie, repo } = oneUser();
    const api = addRepo(database, "acme", "api", [alice.id]);
    addIssue(repo, "acme/web", { number: 1, label: "todo" });
    addIssue(api, "acme/api", { number: 2, label: "todo" });
    addIssue(repo, "acme/web", { number: 3, label: "doing" });
    const board = await createBoard(cookie, {
      baseFilter: "repo:acme/web",
      showOther: true,
    });

    const all = await cardsBody(cookie, board.id);
    expect(numbers(all.columns[0]?.cards)).toEqual([1]);
    expect(numbers(all.columns[1]?.cards)).toEqual([3]);

    const narrowed = await cardsBody(
      cookie,
      board.id,
      `?q=${encodeURIComponent("repo:acme/api")}`,
    );
    expect(narrowed.columns.map((column) => column.count)).toEqual([0, 0]);
    expect(narrowed.other?.count).toBe(0);

    const bad = await cards(cookie, board.id, "?q=%22unterminated");
    expect(bad.status).toBe(400);
    const error = (await bad.json()) as {
      error: { code: string; start: number; end: number };
    };
    expect(error.error.code).toBe("invalid_query");
    expect(error.error.end).toBeGreaterThan(error.error.start);
  });

  it("orders the cards of a column by the board's sort", async () => {
    const { cookie, repo } = oneUser();
    addIssue(repo, "acme/web", { number: 1, label: "todo", updatedAt: 1 });
    addIssue(repo, "acme/web", { number: 2, label: "todo", updatedAt: 3 });
    addIssue(repo, "acme/web", { number: 3, label: "todo", updatedAt: 2 });
    const newest = await createBoard(cookie, { sort: "updated-desc" });
    const oldest = await createBoard(cookie, { sort: "updated-asc" });

    expect(
      numbers((await cardsBody(cookie, newest.id)).columns[0]?.cards),
    ).toEqual([2, 3, 1]);
    expect(
      numbers((await cardsBody(cookie, oldest.id)).columns[0]?.cards),
    ).toEqual([1, 3, 2]);
  });

  it("nests sub-issues under their nearest placed ancestor in collapsed mode", async () => {
    const { cookie, repo } = oneUser();
    const top = addIssue(repo, "acme/web", { number: 1, label: "todo" });
    const middle = addIssue(repo, "acme/web", {
      number: 2,
      parent: { id: top, repo: "acme/web", number: 1 },
    });
    addIssue(repo, "acme/web", {
      number: 3,
      label: "doing",
      parent: { id: middle, repo: "acme/web", number: 2 },
    });
    const unsynced = addUnsyncedRef("acme/web", 90);
    addIssue(repo, "acme/web", {
      number: 4,
      label: "doing",
      parent: { id: unsynced, repo: "acme/web", number: 90 },
    });
    const collapsed = await createBoard(cookie, { sort: "repo-asc" });
    const expanded = await createBoard(cookie, {
      sort: "repo-asc",
      subIssueMode: "expanded",
    });

    const body = await cardsBody(cookie, collapsed.id);
    expect(numbers(body.columns[0]?.cards)).toEqual([1]);
    expect(body.columns[0]?.count).toBe(1);
    expect(numbers(body.columns[1]?.cards)).toEqual([4]);
    expect(body.columns[1]?.count).toBe(1);
    const nested = body.columns[0]?.cards[0]?.children;
    expect(numbers(nested)).toEqual([3]);
    expect(nested?.[0]).toMatchObject({ columnName: "Doing", children: [] });

    const flat = await cardsBody(cookie, expanded.id);
    expect(numbers(flat.columns[0]?.cards)).toEqual([1]);
    expect(numbers(flat.columns[1]?.cards)).toEqual([3, 4]);
    expect(flat.columns[0]?.cards[0]?.children).toBeUndefined();
  });

  it("only places issues of the board owner's repos and never names a parent outside them", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bobby");
    const aliceCookie = signIn(database.db, alice.id).cookie;
    const bobCookie = signIn(database.db, bob.id).cookie;
    const aliceRepo = addRepo(database, "acme", "web", [alice.id]);
    const bobRepo = addRepo(database, "acme", "secret", [bob.id]);
    addIssue(aliceRepo, "acme/web", { number: 1, label: "todo" });
    const secretParent = addIssue(bobRepo, "acme/secret", {
      number: 7,
      label: "todo",
    });
    addIssue(bobRepo, "acme/secret", { number: 8, label: "todo" });
    addIssue(aliceRepo, "acme/web", {
      number: 2,
      label: "todo",
      parent: { id: secretParent, repo: "acme/secret", number: 7 },
    });
    const aliceBoard = await createBoard(aliceCookie, {
      showOther: true,
      sort: "repo-asc",
    });
    const bobBoard = await createBoard(bobCookie, {
      showOther: true,
      sort: "repo-asc",
    });

    const forAlice = await cardsBody(aliceCookie, aliceBoard.id);
    expect(numbers(forAlice.columns[0]?.cards)).toEqual([1, 2]);
    expect(forAlice.other?.count).toBe(0);
    expect(JSON.stringify(forAlice)).not.toContain("secret");

    const forBob = await cardsBody(bobCookie, bobBoard.id);
    expect(numbers(forBob.columns[0]?.cards)).toEqual([7, 8]);
    expect(JSON.stringify(forBob)).not.toContain("acme/web");
  });
});
