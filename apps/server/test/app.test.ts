import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc } from "hono/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createErrorHandler, notFound } from "../src/api/errors.js";
import { validate } from "../src/api/validator.js";
import { createApp, type AppType } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
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
let logs: string[];
let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-app-"));
  webRoot = join(dir, "dist");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><p>shell</p>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1);");
  writeFileSync(join(dir, "secret.txt"), "outside the web root");
  logs = [];
});

afterEach(() => {
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const jsonRequest = {
  Origin: validEnv.CROSSBOARD_PUBLIC_URL,
  "Content-Type": "application/json",
};

const member = () => ({ Cookie: signIn(database.db).cookie });

function build(root = webRoot) {
  const logger = createLogger("info", { write: (chunk) => logs.push(chunk) });
  const config = loadConfig({ ...validEnv, ...githubEnv });
  const setup = createSetup({ db: database.db, config, logger });
  const github = createGithubClient({
    apiUrl: "https://api.github.test",
    webUrl: "https://github.test",
    logger,
  });
  return createApp({
    setup,
    db: database.db,
    appSecret: config.appSecret,
    publicUrl: config.publicUrl,
    logger,
    github,
    installations: unusedInstallations,
    jobs: unusedJobs,
    access: createTestAccess({
      db: database.db,
      github,
      setup,
      appSecret: config.appSecret,
      logger,
    }),
    version: "9.8.7",
    webRoot: root,
  });
}

describe("GET /api/health", () => {
  it("answers status and the server version without credentials", async () => {
    const response = await build().request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "9.8.7" });
  });

  it("is typed through hc<AppType>", async () => {
    const app = build();
    const client = hc<AppType>("http://localhost", { fetch: app.request });
    const response = await client.api.health.$get();
    const body: { status: "ok"; version: string } = await response.json();
    expect(body.version).toBe("9.8.7");
  });
});

describe("error format", () => {
  it("answers unknown /api routes with a 404 in the error shape", async () => {
    const app = build();
    for (const [method, path] of [
      ["GET", "/api/nope"],
      ["GET", "/api"],
      ["POST", "/api/health"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { ...member(), ...jsonRequest },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Not found" },
      });
    }
  });

  it("answers a non-GET to an unknown non-API path with the error shape", async () => {
    const response = await build().request("/somewhere", {
      method: "POST",
      headers: { ...member(), ...jsonRequest },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });

  it("answers an unexpected failure with a generic 500 and logs the cause", async () => {
    const logger = createLogger("info", { write: (chunk) => logs.push(chunk) });
    const app = new Hono()
      .get("/boom", () => {
        throw new Error("database password is hunter2");
      })
      .get("/teapot", () => {
        throw new HTTPException(409, { message: "already there" });
      })
      .notFound(notFound)
      .onError(createErrorHandler(logger));

    const boom = await app.request("/boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(logs.join("")).toContain("hunter2");

    const conflict = await app.request("/teapot");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: "conflict", message: "already there" },
    });
  });
});

describe("validate", () => {
  const app = new Hono()
    .post(
      "/echo",
      validate("json", z.object({ count: z.number(), name: z.string() })),
      (c) => c.json(c.req.valid("json")),
    )
    .get(
      "/page",
      validate("query", z.object({ limit: z.coerce.number().int() })),
      (c) => c.json(c.req.valid("query")),
    )
    .notFound(notFound)
    .onError(createErrorHandler(createLogger("silent")));

  const post = (body: string) =>
    app.request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

  it("passes a valid request through with the parsed value", async () => {
    const response = await post(JSON.stringify({ count: 2, name: "x" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2, name: "x" });
  });

  it("answers a body failing its schema with a 400 in the error shape", async () => {
    const response = await post(JSON.stringify({ count: "two" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("count");
    expect(body.error.message).toContain("name");
  });

  it("answers a query failing its schema with a 400 in the error shape", async () => {
    const response = await app.request("/page?limit=abc");
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_request");
  });

  it("answers malformed JSON with a 400 in the error shape", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });
});

describe("static SPA serving", () => {
  it("serves built files with their content type", async () => {
    const response = await build().request("/assets/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toBe("console.log(1);");
  });

  it("serves index.html at /", async () => {
    const response = await build().request("/", { headers: member() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("shell");
  });

  it("answers client-side routes with index.html so a refresh loads them", async () => {
    const app = build();
    for (const path of ["/i/octocat/hello/42", "/boards/7", "/settings"]) {
      const response = await app.request(path, { headers: member() });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("shell");
    }
  });

  it("does not answer a missing asset with index.html", async () => {
    const response = await build().request("/assets/missing.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("shell");
  });

  it("does not serve files outside the web root", async () => {
    const app = build();
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/../../secret.txt",
    ]) {
      const response = await app.request(path);
      expect(await response.text(), path).not.toContain("outside the web root");
    }
  });

  it("answers 404 in the error shape when the web app was not built", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await build(join(dir, "missing")).request("/settings", {
      headers: member(),
    });
    const errors = logged.mock.calls.length;
    logged.mockRestore();
    expect(errors).toBe(0);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });
});
