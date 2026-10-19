import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_CREDENTIALS_KEY } from "../src/auth/credentials.js";
import {
  createSetup,
  hasValidSetupCookie,
  SETUP_COOKIE,
} from "../src/auth/setup/index.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { encrypt } from "../src/security/index.js";
import { Hono } from "hono";
import { createTestDatabase, type TestDatabase } from "./database.js";
import {
  githubEnv,
  validEnv,
  unusedInstallations,
  unusedJobs,
} from "./helpers.js";
import { signIn, createTestAccess } from "./sign-in.js";

let dir: string;
let webRoot: string;
let database: TestDatabase;
let token: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossboard-setup-"));
  webRoot = join(dir, "dist");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><p>shell</p>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1);");
  writeFileSync(join(webRoot, "favicon.svg"), "<svg/>");
  writeFileSync(join(dir, "secret.txt"), "outside the web root");
  database = createTestDatabase();
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build(env: Record<string, string> = validEnv) {
  const config: Config = loadConfig({
    ...env,
    CROSSBOARD_DATA_DIR: database.dir,
  });
  const logger = createLogger("silent");
  const setup = createSetup({ db: database.db, config, logger });
  token = setup.start() ?? "";
  const github = createGithubClient({
    apiUrl: "https://api.github.test",
    webUrl: "https://github.test",
    logger,
  });
  const app = createApp({
    logger,
    db: database.db,
    github,
    installations: unusedInstallations,
    jobs: unusedJobs,
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
  return { app, config };
}

const ORIGIN = validEnv.CROSSBOARD_PUBLIC_URL;

const exchange = (
  app: ReturnType<typeof build>["app"],
  body: unknown = { token },
  headers: Record<string, string> = {
    Origin: ORIGIN,
    "Content-Type": "application/json",
  },
) =>
  app.request("/api/setup/token", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("setup gate", () => {
  it("redirects every other route to /setup while no credentials exist", async () => {
    const { app } = build();
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/settings"],
      ["GET", "/boards/7"],
      ["GET", "/api/issues"],
      ["GET", "/api/me"],
      ["POST", "/api/anything"],
      ["GET", "/auth/callback"],
      ["POST", "/webhooks/github"],
      ["GET", "/setupx"],
      ["GET", "/api/setupx"],
      ["GET", "/api/healthz"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(302);
      expect(response.headers.get("location"), path).toBe("/setup");
    }
  });

  it("redirects before any session or Authorization check", async () => {
    const { app } = build();
    const response = await app.request("/api/issues", {
      headers: { Cookie: "session=abc", Authorization: "Bearer abc" },
    });
    expect(response.status).toBe(302);
  });

  it("serves the setup page, health and static assets", async () => {
    const { app } = build();
    for (const path of ["/setup", "/setup/"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("shell");
    }
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: "1.0.0" });
    for (const path of ["/assets/app.js", "/favicon.svg"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
    expect((await exchange(app)).status).toBe(204);
  });

  it("does not let a path outside the web root pass as a static file", async () => {
    const { app } = build();
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/../../secret.txt",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).not.toBe(200);
      expect(await response.text(), path).not.toContain("outside the web root");
    }
  });

  it("redirects encoded traversal paths that resolve to a web file", async () => {
    const { app } = build();
    for (const path of [
      "/api/..%2Findex.html",
      "/api/..%2f..%2findex.html",
      "/api/%2e%2e%2Findex.html",
      "/api/..%252Findex.html",
      "/api/boards/..%2F..%2Findex.html",
      "/auth/..%2Findex.html",
      "/webhooks/..%2Findex.html",
      "/assets/..%2Findex.html",
      "/assets/..%5Cindex.html",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/setup");
    }
  });

  it("is lifted when the environment carries the App credentials", async () => {
    const { app } = build({ ...validEnv, ...githubEnv });
    const { cookie } = signIn(database.db);
    const response = await app.request("/settings", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("shell");
    expect(
      (await app.request("/api/nope", { headers: { Cookie: cookie } })).status,
    ).toBe(404);
    expect((await app.request("/api/nope")).status).toBe(401);
  });

  it("is lifted without a restart once the credentials are stored", async () => {
    const { app, config } = build();
    expect((await app.request("/settings")).status).toBe(302);
    database.db
      .insert(schema.appConfig)
      .values({
        key: APP_CREDENTIALS_KEY,
        valueEnc: encrypt(
          JSON.stringify({
            appId: "1",
            appSlug: "a",
            clientId: "c",
            clientSecret: "s",
            privateKey: "k",
            webhookSecret: "w",
          }),
          config.appSecret,
        ),
        updatedAt: 1,
      })
      .run();
    const { cookie } = signIn(database.db);
    expect(
      (await app.request("/settings", { headers: { Cookie: cookie } })).status,
    ).toBe(200);
  });
});

describe("POST /api/setup/token", () => {
  it("exchanges the correct token for a signed 30-minute setup cookie", async () => {
    const { app, config } = build();
    const response = await exchange(app);
    expect(response.status).toBe(204);

    const setCookie = response.headers.get("set-cookie") ?? "";
    const [pair, ...attributes] = setCookie.split("; ");
    expect(pair?.startsWith(`${SETUP_COOKIE}=`)).toBe(true);
    expect(attributes).toEqual(
      expect.arrayContaining([
        "Max-Age=1800",
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ]),
    );

    const check = new Hono().get("/", async (c) =>
      c.json({ valid: await hasValidSetupCookie(c, config) }),
    );
    const withCookie = (cookie: string) =>
      check.request("/", { headers: { Cookie: cookie } });
    expect(await (await withCookie(pair ?? "")).json()).toEqual({
      valid: true,
    });
  });

  it("omits Secure only on http://localhost", async () => {
    for (const [publicUrl, secure] of [
      ["http://localhost:3000", false],
      ["http://crossboard.example.com", true],
      ["https://localhost", true],
    ] as const) {
      const { app } = build({ ...validEnv, CROSSBOARD_PUBLIC_URL: publicUrl });
      const response = await exchange(
        app,
        { token },
        {
          Origin: new URL(publicUrl).origin,
          "Content-Type": "application/json",
        },
      );
      const attributes = (response.headers.get("set-cookie") ?? "").split("; ");
      expect(attributes.includes("Secure"), publicUrl).toBe(secure);
      expect(attributes).toContain("HttpOnly");
      expect(attributes).toContain("SameSite=Lax");
    }
  });

  it("rejects a wrong token with 401 and sets no cookie", async () => {
    const { app } = build();
    for (const wrong of ["wrong", `${token}x`, token.slice(1)]) {
      const response = await exchange(app, { token: wrong });
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
    }
  });

  it("rejects a body without a token with 400 and sets no cookie", async () => {
    const { app } = build();
    for (const body of [{}, { token: "" }, { token: 5 }, "{not json"]) {
      const response = await exchange(app, body);
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("rejects a missing or foreign Origin before looking at the token", async () => {
    const { app } = build();
    for (const origin of [undefined, "https://evil.example.com"]) {
      const response = await exchange(
        app,
        { token },
        {
          ...(origin === undefined ? {} : { Origin: origin }),
          "Content-Type": "application/json",
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("rejects a body over the size limit with 413 and sets no cookie", async () => {
    const { app } = build();
    const oversized = JSON.stringify({ token, padding: "x".repeat(8 * 1024) });
    const response = await exchange(app, oversized);
    expect(response.status).toBe(413);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("rejects an oversized streamed body that declares no length", async () => {
    const { app } = build();
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 16) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    const response = await app.request("/api/setup/token", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a non-JSON body", async () => {
    const { app } = build();
    const response = await exchange(app, `token=${token}`, {
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers 404 once setup is closed, even for the right token", async () => {
    const { app } = build({ ...validEnv, ...githubEnv });
    const response = await exchange(app);
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("setup cookie", () => {
  const cookieOptions = { appSecret: validEnv.CROSSBOARD_APP_SECRET };

  async function issue() {
    const { app } = build();
    const response = await exchange(app);
    return (response.headers.get("set-cookie") ?? "").split("; ")[0] ?? "";
  }

  const probe = async (
    cookie: string,
    now?: number,
    secret = cookieOptions.appSecret,
  ) =>
    (
      await new Hono()
        .get("/", async (c) =>
          c.json({
            valid: await hasValidSetupCookie(c, { appSecret: secret }, now),
          }),
        )
        .request("/", { headers: { Cookie: cookie } })
    ).json();

  it("expires after 30 minutes", async () => {
    const cookie = await issue();
    expect(await probe(cookie, Date.now() + 29 * 60_000)).toEqual({
      valid: true,
    });
    expect(await probe(cookie, Date.now() + 31 * 60_000)).toEqual({
      valid: false,
    });
  });

  it("is invalid when tampered with, unsigned or signed under another secret", async () => {
    const cookie = await issue();
    const [name, value = ""] = cookie.split("=");
    const [payload, signature] = value.split(".");
    const later = String(Number(decodeURIComponent(payload ?? "")) + 3_600_000);
    expect(await probe(`${name}=${later}.${signature}`)).toEqual({
      valid: false,
    });
    expect(await probe(`${name}=${later}`)).toEqual({ valid: false });
    expect(await probe(cookie, undefined, "z".repeat(32))).toEqual({
      valid: false,
    });
    expect(await probe("")).toEqual({ valid: false });
  });
});
