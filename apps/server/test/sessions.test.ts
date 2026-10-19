import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  cleanupSessions,
  createSession,
  findSession,
  issueSession,
  enqueueSessionCleanupAtStart,
  registerSessionCleanup,
  sanitizeReturnPath,
  SESSION_CLEANUP_INTERVAL_MS,
  SESSION_COOKIE,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from "../src/auth/sessions/index.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import {
  CONTENT_SECURITY_POLICY,
  protectStateChanges,
} from "../src/security/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { githubEnv, validEnv, unusedInstallations } from "./helpers.js";
import { addUser, signIn, createTestAccess } from "./sign-in.js";

const ORIGIN = validEnv.CROSSBOARD_PUBLIC_URL;
const HOUR = SESSION_TOUCH_INTERVAL_MS;
const JSON_FROM_ORIGIN = {
  Origin: ORIGIN,
  "Content-Type": "application/json",
};

let dir: string;
let webRoot: string;
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-sessions-"));
  webRoot = join(dir, "dist");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><p>shell</p>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1);");
  writeFileSync(join(webRoot, "favicon.svg"), "<svg/>");
});

afterEach(() => {
  vi.useRealTimers();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build(env: Record<string, string> = { ...validEnv, ...githubEnv }) {
  const config = loadConfig({ ...env, CROSSBOARD_DATA_DIR: database.dir });
  const logger = createLogger("silent");
  const setup = createSetup({ db: database.db, config, logger });
  setup.start();
  const github = createGithubClient({
    apiUrl: "https://api.github.test",
    webUrl: "https://github.test",
    logger,
  });
  return createApp({
    logger,
    db: database.db,
    github,
    installations: unusedInstallations,
    version: "1.0.0",
    webRoot,
    setup,
    access: createTestAccess({
      db: database.db,
      github,
      setup,
      appSecret: config.appSecret,
      logger,
    }),
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
  });
}

const sessionRow = (token: string) =>
  database.db
    .select()
    .from(schema.sessions)
    .where(
      eq(
        schema.sessions.tokenHash,
        createHash("sha256").update(token).digest("hex"),
      ),
    )
    .get();

const sessionCount = () =>
  database.db.select().from(schema.sessions).all().length;

function addTokens(userId: number) {
  database.db
    .insert(schema.userTokens)
    .values({
      userId,
      accessTokenEnc: "v1:a:b:c",
      accessExpiresAt: 1,
      refreshTokenEnc: "v1:a:b:c",
      refreshExpiresAt: 1,
      updatedAt: 1,
    })
    .run();
}

const tokenRows = () => database.db.select().from(schema.userTokens).all();

describe("session cookie", () => {
  const issuing = (publicUrl: string) =>
    new Hono().post("/sign-in", (c) => {
      issueSession(c, { db: database.db, publicUrl }, addUser(database.db).id);
      return c.body(null, 204);
    });

  it("is an HTTP-only, SameSite=Lax, Secure cookie holding a random 32-byte token", async () => {
    const response = await issuing(ORIGIN).request("/sign-in", {
      method: "POST",
    });
    const header = response.headers.get("set-cookie") ?? "";
    const [pair, ...attributes] = header.split("; ");
    expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
    expect(attributes).toEqual(
      expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]),
    );
    expect(attributes).toContain(`Max-Age=${String(SESSION_TTL_MS / 1000)}`);
    const token = pair?.split("=")[1] ?? "";
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is not Secure on http://localhost, and Secure on any other http origin", async () => {
    const local = await issuing("http://localhost:3000").request("/sign-in", {
      method: "POST",
    });
    expect(local.headers.get("set-cookie")).not.toContain("Secure");
    expect(local.headers.get("set-cookie")).toContain("HttpOnly");
    const other = await issuing("http://crossboard.lan").request("/sign-in", {
      method: "POST",
    });
    expect(other.headers.get("set-cookie")).toContain("Secure");
  });

  it("stores only the SHA-256 hash of the token", async () => {
    const response = await issuing(ORIGIN).request("/sign-in", {
      method: "POST",
    });
    const token =
      response.headers.get("set-cookie")?.split(";")[0]?.split("=")[1] ?? "";
    const rows = database.db.select().from(schema.sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe("session expiry", () => {
  const T0 = 1_700_000_000_000;

  it("lasts 30 days from the last advance", () => {
    const userId = addUser(database.db).id;
    const token = createSession(database.db, userId, T0);
    expect(sessionRow(token)?.expiresAt).toBe(T0 + SESSION_TTL_MS);
    const justBefore = createSession(database.db, userId, T0);
    expect(
      findSession(database.db, justBefore, T0 + SESSION_TTL_MS - 1),
    ).not.toBeNull();
    expect(findSession(database.db, token, T0 + SESSION_TTL_MS)).toBeNull();
  });

  it("advances last_seen_at and expires_at at most once per hour", () => {
    const token = createSession(database.db, addUser(database.db).id, T0);

    const early = findSession(database.db, token, T0 + HOUR - 1);
    expect(early?.refreshed).toBe(false);
    expect(sessionRow(token)).toMatchObject({
      lastSeenAt: T0,
      expiresAt: T0 + SESSION_TTL_MS,
    });

    const due = findSession(database.db, token, T0 + HOUR);
    expect(due?.refreshed).toBe(true);
    expect(sessionRow(token)).toMatchObject({
      lastSeenAt: T0 + HOUR,
      expiresAt: T0 + HOUR + SESSION_TTL_MS,
    });

    expect(findSession(database.db, token, T0 + HOUR + 1000)?.refreshed).toBe(
      false,
    );
    expect(sessionRow(token)?.lastSeenAt).toBe(T0 + HOUR);
  });

  it("does not revive an expired session", () => {
    const token = createSession(database.db, addUser(database.db).id, T0);
    expect(
      findSession(database.db, token, T0 + SESSION_TTL_MS + HOUR),
    ).toBeNull();
    expect(sessionRow(token)?.lastSeenAt).toBe(T0);
  });
});

describe("API session requirement", () => {
  it.each(["/api/nope", "/api", "/api/issues", "/api/me"])(
    "answers 401 in the error shape on %s without a session",
    async (path) => {
      const response = await build().request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
    },
  );

  it("answers 401 for an unknown, a malformed and an expired session cookie", async () => {
    const app = build();
    const user = addUser(database.db);
    const expired = createSession(
      database.db,
      user.id,
      Date.now() - SESSION_TTL_MS - 1,
    );
    for (const value of ["unknown", "", "a".repeat(43), expired]) {
      const response = await app.request("/api/nope", {
        headers: { Cookie: `${SESSION_COOKIE}=${value}` },
      });
      expect(response.status, value).toBe(401);
    }
  });

  it("does not take the token hash as a credential", async () => {
    const { token } = signIn(database.db);
    const hash = createHash("sha256").update(token).digest("hex");
    const response = await build().request("/api/nope", {
      headers: { Cookie: `${SESSION_COOKIE}=${hash}` },
    });
    expect(response.status).toBe(401);
  });

  it("lets a valid session through to the route", async () => {
    const response = await build().request("/api/nope", {
      headers: { Cookie: signIn(database.db).cookie },
    });
    expect(response.status).toBe(404);
  });

  it("leaves the health endpoint and the setup routes without a session", async () => {
    expect((await build().request("/api/health")).status).toBe(200);
    const required = build(validEnv);
    const response = await required.request("/api/setup/token", {
      method: "POST",
      headers: JSON_FROM_ORIGIN,
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("setup") as string },
    });
  });

  it("extends the cookie along with the session, at most once per hour", async () => {
    const app = build();
    const { cookie, token } = signIn(
      database.db,
      addUser(database.db).id,
      Date.now() - 2 * HOUR,
    );
    const first = await app.request("/api/nope", {
      headers: { Cookie: cookie },
    });
    expect(first.headers.get("set-cookie")).toContain(
      `${SESSION_COOKIE}=${token}`,
    );
    expect(sessionRow(token)?.expiresAt).toBeGreaterThan(
      Date.now() + SESSION_TTL_MS - HOUR,
    );
    const second = await app.request("/api/nope", {
      headers: { Cookie: cookie },
    });
    expect(second.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /auth/logout", () => {
  const logout = (app: ReturnType<typeof build>, cookie?: string) =>
    app.request("/auth/logout", {
      method: "POST",
      headers: { ...JSON_FROM_ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
    });

  it("deletes the session and clears the cookie", async () => {
    const app = build();
    const { cookie, token } = signIn(database.db);
    const response = await logout(app, cookie);
    expect(response.status).toBe(204);
    expect(sessionRow(token)).toBeUndefined();
    const cleared = response.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(cleared).toContain("HttpOnly");
    const after = await app.request("/api/nope", {
      headers: { Cookie: cookie },
    });
    expect(after.status).toBe(401);
  });

  it("keeps the user's tokens while another session remains, and deletes them with the last", async () => {
    const app = build();
    const { userId, cookie: first } = signIn(database.db);
    const { cookie: second } = signIn(database.db, userId);
    const other = signIn(database.db);
    addTokens(userId);
    addTokens(other.userId);

    await logout(app, first);
    expect(
      tokenRows()
        .map((row) => row.userId)
        .sort(),
    ).toEqual([userId, other.userId].sort());

    await logout(app, second);
    expect(tokenRows().map((row) => row.userId)).toEqual([other.userId]);
    expect(sessionCount()).toBe(1);
  });

  it("does not count an expired session as remaining", async () => {
    const app = build();
    const { userId, cookie } = signIn(database.db);
    createSession(database.db, userId, Date.now() - SESSION_TTL_MS - HOUR);
    addTokens(userId);
    await logout(app, cookie);
    expect(tokenRows()).toEqual([]);
  });

  it("answers 204 without a session and touches nothing", async () => {
    const app = build();
    const { userId } = signIn(database.db);
    addTokens(userId);
    expect((await logout(app)).status).toBe(204);
    expect((await logout(app, `${SESSION_COOKIE}=nonsense`)).status).toBe(204);
    expect(sessionCount()).toBe(1);
    expect(tokenRows()).toHaveLength(1);
  });

  it("rejects a missing or foreign Origin and a non-JSON body, leaving the session", async () => {
    const app = build();
    const { cookie, token } = signIn(database.db);
    const noOrigin = await app.request("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
    });
    expect(noOrigin.status).toBe(403);
    const foreign = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        ...JSON_FROM_ORIGIN,
        Origin: "https://evil.example",
        Cookie: cookie,
      },
    });
    expect(foreign.status).toBe(403);
    const form = await app.request("/auth/logout", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: "a=b",
    });
    expect(form.status).toBe(415);
    expect(sessionRow(token)).toBeDefined();
  });

  it("is POST only", async () => {
    const { cookie, token } = signIn(database.db);
    const response = await build().request("/auth/logout", {
      headers: { Cookie: cookie },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(sessionRow(token)).toBeDefined();
  });
});

describe("CSRF protection of state-changing routes", () => {
  it.each(["POST", "PATCH", "DELETE"])(
    "rejects a %s to a session route without a same-origin JSON request",
    async (method) => {
      const app = build();
      const { cookie } = signIn(database.db);
      const noOrigin = await app.request("/api/nope", {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
      });
      expect(noOrigin.status).toBe(403);
      const foreign = await app.request("/api/nope", {
        method,
        headers: {
          ...JSON_FROM_ORIGIN,
          Origin: "https://evil.example",
          Cookie: cookie,
        },
      });
      expect(foreign.status).toBe(403);
      const text = await app.request("/api/nope", {
        method,
        headers: {
          Origin: ORIGIN,
          "Content-Type": "text/plain",
          Cookie: cookie,
        },
      });
      expect(text.status).toBe(415);
      const ok = await app.request("/api/nope", {
        method,
        headers: { ...JSON_FROM_ORIGIN, Cookie: cookie },
      });
      expect(ok.status).toBe(404);
    },
  );

  it("guards a route added later without it opting in", async () => {
    const app = new Hono()
      .use(protectStateChanges(ORIGIN))
      .put("/later", (c) => c.body(null, 204))
      .get("/read", (c) => c.body(null, 204));
    expect((await app.request("/later", { method: "PUT" })).status).toBe(403);
    expect((await app.request("/read")).status).toBe(204);
  });

  it("exempts only the webhook route", async () => {
    const app = new Hono()
      .use(protectStateChanges(ORIGIN))
      .post("/webhooks/github", (c) => c.body(null, 202))
      .post("/webhooks/github/other", (c) => c.body(null, 202));
    expect(
      (await app.request("/webhooks/github", { method: "POST" })).status,
    ).toBe(202);
    expect(
      (await app.request("/webhooks/github/other", { method: "POST" })).status,
    ).toBe(403);
  });

  it("leaves the webhook route to its own signature check in the app", async () => {
    const response = await build().request("/webhooks/github", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});

describe("Content-Security-Policy", () => {
  it("is the policy of SPEC §9.3", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com https://*.githubusercontent.com https://github.com https://camo.githubusercontent.com data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
    );
  });

  it("is on every kind of response", async () => {
    const app = build();
    const { cookie } = signIn(database.db);
    const requests: [string, RequestInit?][] = [
      ["/api/health"],
      ["/api/nope"],
      ["/api/nope", { headers: { Cookie: cookie } }],
      ["/assets/app.js"],
      ["/assets/missing.js"],
      ["/favicon.svg"],
      ["/", { headers: { Cookie: cookie } }],
      ["/"],
      ["/boards/1", { headers: { Cookie: cookie } }],
      ["/auth/logout", { method: "POST" }],
      ["/somewhere", { method: "POST", headers: JSON_FROM_ORIGIN }],
    ];
    for (const [path, init] of requests) {
      const response = await app.request(path, init);
      expect(
        response.headers.get("content-security-policy"),
        `${init?.method ?? "GET"} ${path} ${String(response.status)}`,
      ).toBe(CONTENT_SECURITY_POLICY);
    }
  });

  it("is on the setup redirect and setup responses", async () => {
    const app = build(validEnv);
    for (const path of ["/", "/setup", "/api/health"]) {
      const response = await app.request(path);
      expect(response.headers.get("content-security-policy"), path).toBe(
        CONTENT_SECURITY_POLICY,
      );
    }
  });

  it("is on an unexpected-failure response", async () => {
    const app = new Hono().use(
      (await import("../src/security/index.js")).contentSecurityPolicy(),
    );
    app.get("/boom", () => {
      throw new Error("boom");
    });
    const response = await app.request("/boom");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-security-policy")).toBe(
      CONTENT_SECURITY_POLICY,
    );
  });
});

describe("SPA fallback without a session", () => {
  const location = (response: Response) => response.headers.get("location");

  it("redirects a page request to /auth/login with the path to return to", async () => {
    const app = build();
    for (const [path, expected] of [
      ["/", "/"],
      ["/settings", "/settings"],
      ["/boards/7", "/boards/7"],
      ["/i/octocat/hello/42", "/i/octocat/hello/42"],
      ["/?q=is%3Aopen+label%3Abug", "/?q=is%3Aopen+label%3Abug"],
      ["/index.html", "/index.html"],
    ] as const) {
      const response = await app.request(path);
      expect(response.status, path).toBe(302);
      expect(location(response), path).toBe(
        `/auth/login?return=${encodeURIComponent(expected)}`,
      );
    }
  });

  it("does not serve the shell to the redirected request", async () => {
    const response = await build().request("/");
    expect(await response.text()).not.toContain("shell");
  });

  it("serves the shell to a request with a session", async () => {
    const response = await build().request("/boards/7", {
      headers: { Cookie: signIn(database.db).cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("shell");
  });

  it("redirects a request with an expired session", async () => {
    const { cookie } = signIn(
      database.db,
      addUser(database.db).id,
      Date.now() - SESSION_TTL_MS - 1,
    );
    const response = await build().request("/settings", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(302);
  });

  it("exempts /setup, /setup/* and /auth/*", async () => {
    const required = build(validEnv);
    for (const path of ["/setup", "/setup/"]) {
      const response = await required.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("shell");
    }
    const app = build();
    for (const path of ["/auth/not-allowed", "/auth/x/y"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("shell");
    }
  });

  it("serves the built files without a session, and 404s a missing asset", async () => {
    const app = build();
    expect((await app.request("/assets/app.js")).status).toBe(200);
    expect((await app.request("/favicon.svg")).status).toBe(200);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
  });

  it("keeps a protocol-relative path from becoming the return target", async () => {
    const response = await build().request("//evil.example/x");
    expect(response.status).toBe(302);
    expect(location(response)).toBe("/auth/login?return=%2F");
  });
});

describe("sanitizeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/settings", "/settings"],
    ["/boards/7?x=1#frag", "/boards/7?x=1#frag"],
    [undefined, "/"],
    ["", "/"],
    ["settings", "/"],
    ["https://evil.example/x", "/"],
    ["http://evil.example", "/"],
    ["//evil.example/x", "/"],
    ["///evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/\tfoo", "/"],
    ["/ok\nSet-Cookie: a=b", "/"],
    ["javascript:alert(1)", "/"],
  ])("maps %j to %j", (value, expected) => {
    expect(sanitizeReturnPath(value)).toBe(expected);
  });
});

describe("daily session cleanup", () => {
  it("deletes expired sessions, then the tokens of users left without one", () => {
    const now = Date.now();
    const lapsed = addUser(database.db);
    createSession(database.db, lapsed.id, now - SESSION_TTL_MS - 1);
    addTokens(lapsed.id);
    const mixed = addUser(database.db);
    createSession(database.db, mixed.id, now - SESSION_TTL_MS - 1);
    const live = createSession(database.db, mixed.id, now);
    addTokens(mixed.id);
    const active = signIn(database.db);
    addTokens(active.userId);

    expect(cleanupSessions(database.db, now)).toEqual({
      sessions: 2,
      tokens: 1,
    });
    expect(sessionRow(live)).toBeDefined();
    expect(sessionCount()).toBe(2);
    expect(
      tokenRows()
        .map((row) => row.userId)
        .sort(),
    ).toEqual([mixed.id, active.userId].sort());
  });

  it("runs from the jobs interface once a day", async () => {
    vi.useFakeTimers();
    const user = addUser(database.db);
    createSession(database.db, user.id, Date.now() - SESSION_TTL_MS - 1);
    addTokens(user.id);
    const jobs = createJobs({ logger: createLogger("silent") });
    registerSessionCleanup(jobs, database.db, createLogger("silent"));
    jobs.start();

    await vi.advanceTimersByTimeAsync(SESSION_CLEANUP_INTERVAL_MS - 1);
    expect(sessionCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessionCount()).toBe(0);
    expect(tokenRows()).toEqual([]);
    await jobs.stop();
  });

  it("runs once at start through the jobs interface, without waiting a day", async () => {
    const user = addUser(database.db);
    createSession(database.db, user.id, Date.now() - SESSION_TTL_MS - 1);
    addTokens(user.id);
    const jobs = createJobs({ logger: createLogger("silent") });
    registerSessionCleanup(jobs, database.db, createLogger("silent"));
    jobs.start();

    expect(enqueueSessionCleanupAtStart(jobs)).toBe(true);
    await jobs.stop();
    expect(sessionCount()).toBe(0);
    expect(tokenRows()).toEqual([]);
  });

  it("is a daily interval", () => {
    expect(SESSION_CLEANUP_INTERVAL_MS).toBe(24 * HOUR);
  });
});
