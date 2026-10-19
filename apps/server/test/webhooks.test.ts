import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createJobs, type Jobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";
import { verifySignature } from "../src/webhooks/index.js";
import type { WebhookDelivery, WebhookHandler } from "../src/webhooks/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { githubEnv, unusedInstallations, validEnv } from "./helpers.js";
import { createTestAccess } from "./sign-in.js";

const SECRET = githubEnv.GITHUB_WEBHOOK_SECRET;
const ACTIVE = 7;
const INACTIVE = 8;

let dir: string;
let database: TestDatabase;
let jobs: Jobs;
let logs: Record<string, unknown>[];
let deliveries: WebhookDelivery[];

beforeEach(() => {
  database = createTestDatabase();
  dir = mkdtempSync(join(tmpdir(), "crossboard-webhooks-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html>");
  logs = [];
  deliveries = [];
  for (const [id, login] of [
    [ACTIVE, "octocat"],
    [INACTIVE, "stranger"],
  ] as const) {
    database.db
      .insert(schema.installations)
      .values({
        id,
        accountLogin: login,
        accountId: id,
        accountType: "User",
        suspended: false,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  }
});

afterEach(async () => {
  await jobs.stop();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const record: WebhookHandler = (delivery) => {
  deliveries.push(delivery);
};

function build(
  options: {
    level?: "info" | "debug";
    env?: Record<string, string>;
    handlers?: Record<string, WebhookHandler>;
  } = {},
) {
  const logger = createLogger(options.level ?? "debug", {
    write: (chunk) => logs.push(JSON.parse(chunk) as Record<string, unknown>),
  });
  const config = loadConfig({ ...validEnv, ...githubEnv, ...options.env });
  const setup = createSetup({ db: database.db, config, logger });
  const github = createGithubClient({
    apiUrl: config.githubApiUrl,
    webUrl: config.githubWebUrl,
    logger,
  });
  jobs = createJobs({ logger });
  jobs.start();
  return createApp({
    logger,
    db: database.db,
    github,
    installations: unusedInstallations,
    jobs,
    webhookHandlers: options.handlers ?? {
      issues: record,
      installation: record,
      installation_repositories: record,
      github_app_authorization: record,
    },
    version: "1.0.0",
    webRoot: join(dir, "dist"),
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

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function deliver(
  app: ReturnType<typeof build>,
  event: string,
  payload: unknown,
  headers: Record<string, string> = {},
  body = JSON.stringify(payload),
) {
  return app.request("/webhooks/github", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": `delivery-${String(Math.random())}`,
      "X-Hub-Signature-256": sign(body),
      ...headers,
    },
  });
}

function rowCounts() {
  return [
    schema.installations,
    schema.repos,
    schema.users,
    schema.userInstallations,
    schema.sessions,
    schema.appConfig,
  ].map((table) => database.db.select().from(table).all().length);
}

const issuePayload = (installation: number, extra: object = {}) => ({
  action: "opened",
  installation: { id: installation },
  repository: { private: true },
  ...extra,
});

describe("signature", () => {
  it("answers 401 to a tampered body without enqueueing or writing", async () => {
    const app = build();
    const body = JSON.stringify(issuePayload(ACTIVE));
    const before = rowCounts();
    const response = await deliver(
      app,
      "issues",
      null,
      { "X-Hub-Signature-256": sign(body) },
      body.replace('"opened"', '"closed"'),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(deliveries).toEqual([]);
    expect(rowCounts()).toEqual(before);
  });

  it("answers 401 to a missing or malformed signature header", async () => {
    const app = build();
    const body = JSON.stringify(issuePayload(ACTIVE));
    for (const header of [
      undefined,
      "",
      "sha256=",
      "sha256=zz",
      sign(body).replace("sha256=", "sha1="),
      sign(body).slice("sha256=".length),
      `${sign(body)}00`,
    ]) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "d",
      };
      if (header !== undefined) headers["X-Hub-Signature-256"] = header;
      const response = await app.request("/webhooks/github", {
        method: "POST",
        body,
        headers,
      });
      expect(response.status, String(header)).toBe(401);
    }
    expect(deliveries).toEqual([]);
  });

  it("answers 401 to a body signed with the wrong secret", async () => {
    const app = build();
    const body = JSON.stringify(issuePayload(ACTIVE));
    const response = await deliver(app, "issues", null, {
      "X-Hub-Signature-256": sign(body, "another secret"),
    });
    expect(response.status).toBe(401);
    expect(deliveries).toEqual([]);
  });

  it("is not served while no webhook secret is configured", async () => {
    const app = build({
      env: Object.fromEntries(Object.keys(githubEnv).map((key) => [key, ""])),
    });
    const response = await deliver(app, "issues", issuePayload(ACTIVE));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
    expect(deliveries).toEqual([]);
  });

  it("verifies before parsing: an unsigned body that is not JSON is a 401", async () => {
    const app = build();
    const response = await deliver(
      app,
      "issues",
      null,
      { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
      "{not json",
    );
    expect(response.status).toBe(401);
  });

  it("accepts the signature of the exact body", async () => {
    const body = '{"a":1}';
    expect(await verifySignature("s", body, sign(body, "s"))).toBe(true);
    expect(await verifySignature("t", body, sign(body, "s"))).toBe(false);
    expect(await verifySignature("s", "", sign("", "s"))).toBe(false);
  });

  it("answers 413 to a body over 25 MB without enqueueing or writing", async () => {
    const app = build();
    const before = rowCounts();
    const body = "x".repeat(25 * 1024 * 1024 + 1);
    const response = await deliver(app, "issues", null, {}, body);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
    expect(deliveries).toEqual([]);
    expect(rowCounts()).toEqual(before);
  });
});

describe("a valid delivery", () => {
  it("is acknowledged with 202 and handed to the handler by event name", async () => {
    const app = build();
    const payload = issuePayload(ACTIVE);
    const response = await deliver(app, "issues", payload, {
      "X-GitHub-Delivery": "abc-123",
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    expect(deliveries[0]).toMatchObject({
      event: "issues",
      action: "opened",
      deliveryId: "abc-123",
      installationId: ACTIVE,
      payload,
    });
  });

  it("is acknowledged without a session, an Origin or a JSON content type", async () => {
    const app = build();
    const body = JSON.stringify(issuePayload(ACTIVE));
    const response = await app.request("/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://evil.example",
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "d",
        "X-Hub-Signature-256": sign(body),
      },
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
  });

  it("answers 400 to a signed body that is not a JSON object, or lacks the event headers", async () => {
    const app = build();
    for (const body of ["{not json", "[1]", "null"]) {
      const response = await deliver(app, "issues", null, {}, body);
      expect(response.status, body).toBe(400);
    }
    const body = JSON.stringify(issuePayload(ACTIVE));
    const response = await app.request("/webhooks/github", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": sign(body) },
    });
    expect(response.status).toBe(400);
    expect(deliveries).toEqual([]);
  });

  it("answers 503 once the job queue is stopped, so the delivery is not lost silently", async () => {
    const app = build();
    await jobs.stop();
    const response = await deliver(app, "issues", issuePayload(ACTIVE));
    expect(response.status).toBe(503);
  });
});

describe("installation activity", () => {
  it("acknowledges and drops a delivery for an inactive installation", async () => {
    const app = build();
    const response = await deliver(app, "issues", issuePayload(INACTIVE));
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deliveries).toEqual([]);
  });

  it("drops a delivery for an installation that is not recorded", async () => {
    const app = build();
    const response = await deliver(app, "issues", issuePayload(999));
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deliveries).toEqual([]);
  });

  it("still applies the installation events that may change the active set", async () => {
    const app = build();
    for (const event of ["installation", "installation_repositories"]) {
      const response = await deliver(app, event, {
        action: "created",
        installation: { id: INACTIVE },
      });
      expect(response.status).toBe(202);
    }
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    expect(deliveries.map((d) => d.event)).toEqual([
      "installation",
      "installation_repositories",
    ]);
  });

  it("applies an event that names no installation", async () => {
    const app = build();
    const response = await deliver(app, "github_app_authorization", {
      action: "revoked",
      sender: { login: "octocat" },
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    expect(deliveries[0]?.installationId).toBeUndefined();
  });

  it("acknowledges an event without a handler and drops it", async () => {
    const app = build();
    const response = await deliver(app, "ping", {
      zen: "Keep it logically awesome.",
    });
    expect(response.status).toBe(202);
    expect(deliveries).toEqual([]);
  });
});

describe("logging", () => {
  const PRIVATE = "private-marker-3b81f6";
  const PUBLIC = "public-marker-9c2d47";

  it("never logs a private repo's payload, even at debug", async () => {
    const app = build({ level: "debug" });
    await deliver(
      app,
      "issues",
      issuePayload(ACTIVE, { issue: { title: PRIVATE } }),
    );
    await deliver(
      app,
      "issues",
      issuePayload(ACTIVE, { repository: {}, issue: { title: PRIVATE } }),
    );
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    expect(JSON.stringify(logs)).not.toContain(PRIVATE);
  });

  it("logs a public repo's payload only at debug", async () => {
    const payload = issuePayload(ACTIVE, {
      repository: { private: false },
      issue: { title: PUBLIC },
    });
    const info = build({ level: "info" });
    await deliver(info, "issues", payload);
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    expect(JSON.stringify(logs)).not.toContain(PUBLIC);
    await jobs.stop();

    logs.length = 0;
    const debug = build({ level: "debug" });
    await deliver(debug, "issues", payload);
    expect(JSON.stringify(logs)).toContain(PUBLIC);
  });

  it("logs the event, action and ids, and hands handlers a logger bound to them", async () => {
    const app = build({
      level: "info",
      handlers: {
        issues: (delivery) => {
          delivery.logger.info("applied");
        },
      },
    });
    await deliver(app, "issues", issuePayload(ACTIVE), {
      "X-GitHub-Delivery": "id-1",
    });
    await vi.waitFor(() =>
      expect(logs.some((entry) => entry.msg === "applied")).toBe(true),
    );
    const applied = logs.find((entry) => entry.msg === "applied");
    expect(applied).toMatchObject({
      event: "issues",
      action: "opened",
      delivery: "id-1",
      installationId: ACTIVE,
    });
    expect(applied).not.toHaveProperty("payload");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});
