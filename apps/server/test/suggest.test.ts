import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestionsSchema } from "../src/api/schemas.js";
import { schema } from "../src/db/index.js";
import { addInstallation, addRepo, buildApiApp } from "./api-app.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { addUser, signIn } from "./sign-in.js";

let dir: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-suggest-"));
  addInstallation(database);
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

let nextIssue = 1;

function addIssue(
  repoId: string,
  seed: {
    authorLogin?: string | null;
    typeName?: string | null;
    milestoneTitle?: string | null;
  } = {},
): string {
  const n = nextIssue++;
  const id = `I_${String(n)}`;
  database.db
    .insert(schema.issues)
    .values({
      id,
      databaseId: n,
      repoId,
      number: n,
      title: `Issue ${String(n)}`,
      url: `https://github.com/x/y/issues/${String(n)}`,
      authorLogin: seed.authorLogin ?? null,
      typeName: seed.typeName ?? null,
      typeColor: null,
      milestoneTitle: seed.milestoneTitle ?? null,
      milestoneUrl: seed.milestoneTitle ? "https://github.com/x/y/m/1" : null,
      parentId: null,
      subTotal: 0,
      subCompleted: 0,
      blockedByTotal: 0,
      blockingTotal: 0,
      createdAt: 1,
      updatedAt: 1,
      syncedAt: 1,
    })
    .run();
  return id;
}

function addLabel(repoId: string, name: string) {
  database.db
    .insert(schema.labels)
    .values({
      id: `L_${repoId}_${name}`,
      repoId,
      name,
      color: "ffffff",
      description: null,
    })
    .run();
}

function addAssignee(issueId: string, login: string) {
  database.db
    .insert(schema.issueAssignees)
    .values({ issueId, login, avatarUrl: "https://a/x" })
    .run();
}

async function suggest(cookie: string, field: string, prefix?: string) {
  const query = new URLSearchParams({ field });
  if (prefix !== undefined) query.set("prefix", prefix);
  return buildApiApp(database, dir).request(
    `/api/suggest?${query.toString()}`,
    {
      headers: { Cookie: cookie },
    },
  );
}

async function values(cookie: string, field: string, prefix?: string) {
  const response = await suggest(cookie, field, prefix);
  expect(response.status).toBe(200);
  return suggestionsSchema.parse(await response.json()).values;
}

describe("GET /api/suggest", () => {
  it("rejects a request without a session", async () => {
    const response = await buildApiApp(database, dir).request(
      "/api/suggest?field=label",
    );
    expect(response.status).toBe(401);
  });

  it("answers 400 for an unknown or missing field", async () => {
    const alice = addUser(database.db, "octocat");
    const { cookie } = signIn(database.db, alice.id);

    expect((await suggest(cookie, "color")).status).toBe(400);
    expect((await suggest(cookie, "is")).status).toBe(400);
    const missing = await buildApiApp(database, dir).request("/api/suggest", {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(400);
  });

  it("suggests every supported field from the user's repos", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo(database, "acme", "web", [alice.id]);
    addLabel(repo, "bug");
    const issue = addIssue(repo, {
      authorLogin: "carol",
      typeName: "Feature",
      milestoneTitle: "v1 beta",
    });
    addAssignee(issue, "bob");
    const { cookie } = signIn(database.db, alice.id);

    expect(await values(cookie, "label")).toEqual(["bug"]);
    expect(await values(cookie, "assignee")).toEqual(["bob"]);
    expect(await values(cookie, "author")).toEqual(["carol"]);
    expect(await values(cookie, "repo")).toEqual(["acme/web"]);
    expect(await values(cookie, "org")).toEqual(["acme"]);
    expect(await values(cookie, "user")).toEqual(["acme"]);
    expect(await values(cookie, "type")).toEqual(["Feature"]);
    expect(await values(cookie, "milestone")).toEqual(["v1 beta"]);
  });

  it("matches by case-insensitive prefix and sorts the values", async () => {
    const alice = addUser(database.db, "octocat");
    const repo = addRepo(database, "acme", "web", [alice.id]);
    for (const name of ["Bug", "backend", "docs", "a-bug"]) {
      addLabel(repo, name);
    }
    const { cookie } = signIn(database.db, alice.id);

    expect(await values(cookie, "label", "B")).toEqual(["backend", "Bug"]);
    expect(await values(cookie, "label", "bu")).toEqual(["Bug"]);
    expect(await values(cookie, "label", "ug")).toEqual([]);
    expect(await values(cookie, "label")).toEqual([
      "a-bug",
      "backend",
      "Bug",
      "docs",
    ]);
    expect(await values(cookie, "repo", "ACME/W")).toEqual(["acme/web"]);
  });

  it("returns at most 20 distinct values", async () => {
    const alice = addUser(database.db, "octocat");
    const first = addRepo(database, "acme", "one", [alice.id]);
    const second = addRepo(database, "acme", "two", [alice.id]);
    for (let n = 0; n < 25; n++) {
      const name = `label-${String(n).padStart(2, "0")}`;
      addLabel(first, name);
      addLabel(second, name);
    }
    const { cookie } = signIn(database.db, alice.id);

    const all = await values(cookie, "label");
    expect(all).toHaveLength(20);
    expect(new Set(all).size).toBe(20);
    expect(all[0]).toBe("label-00");
  });

  it("never suggests a value that only exists in a repo outside the user's access", async () => {
    const alice = addUser(database.db, "octocat");
    const bob = addUser(database.db, "bobby");
    const shared = addRepo(database, "acme", "shared", [alice.id, bob.id]);
    const secret = addRepo(database, "hidden", "vault", [bob.id]);
    addLabel(shared, "public-label");
    addLabel(secret, "secret-label");
    const sharedIssue = addIssue(shared, {
      authorLogin: "alice-friend",
      typeName: "Bug",
      milestoneTitle: "Open milestone",
    });
    const secretIssue = addIssue(secret, {
      authorLogin: "secret-author",
      typeName: "Secret type",
      milestoneTitle: "Secret milestone",
    });
    addAssignee(sharedIssue, "visible-dev");
    addAssignee(secretIssue, "secret-dev");
    const aliceCookie = signIn(database.db, alice.id).cookie;
    const bobCookie = signIn(database.db, bob.id).cookie;

    expect(await values(aliceCookie, "label")).toEqual(["public-label"]);
    expect(await values(aliceCookie, "assignee")).toEqual(["visible-dev"]);
    expect(await values(aliceCookie, "author")).toEqual(["alice-friend"]);
    expect(await values(aliceCookie, "repo")).toEqual(["acme/shared"]);
    expect(await values(aliceCookie, "org")).toEqual(["acme"]);
    expect(await values(aliceCookie, "type")).toEqual(["Bug"]);
    expect(await values(aliceCookie, "milestone")).toEqual(["Open milestone"]);
    expect(await values(aliceCookie, "label", "secret")).toEqual([]);

    expect(await values(bobCookie, "label")).toEqual([
      "public-label",
      "secret-label",
    ]);
    expect(await values(bobCookie, "org")).toEqual(["acme", "hidden"]);
  });
});
