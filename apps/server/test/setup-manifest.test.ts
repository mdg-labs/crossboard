import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createApp } from "../src/app.js";
import {
  APP_CREDENTIALS_KEY,
  resolveCredentials,
} from "../src/auth/credentials.js";
import {
  createSetup,
  readSetupCookie,
  SETUP_COOKIE,
} from "../src/auth/setup/index.js";
import { loadConfig, type Config } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createGithubClient } from "../src/github/index.js";
import { createLogger } from "../src/logger.js";
import { decrypt, encrypt } from "../src/security/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { createFakeGithub, FAKE_API_URL, FAKE_WEB_URL } from "./github-fake.js";
import {
  githubEnv,
  SENTINEL,
  validEnv,
  unusedInstallations,
  unusedJobs,
} from "./helpers.js";
import { signIn as startSession, createTestAccess } from "./sign-in.js";

const ORIGIN = validEnv.CROSSBOARD_PUBLIC_URL;
const APP_SECRET = validEnv.CROSSBOARD_APP_SECRET;
const GOOD_CODE = "good-manifest-code";

const converted = {
  id: 4242,
  slug: "crossboard-sentinel",
  client_id: "Iv1.sentinelclient",
  client_secret: `client-${SENTINEL}`,
  webhook_secret: `hook-${SENTINEL}`,
  pem: `-----BEGIN RSA PRIVATE KEY-----\nkey-${SENTINEL}\n-----END RSA PRIVATE KEY-----\n`,
};
const secrets = [converted.client_secret, converted.webhook_secret, SENTINEL];

const fake = createFakeGithub();
beforeAll(() => fake.listen());
afterAll(() => fake.close());

let dir: string;
let database: TestDatabase;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossboard-manifest-"));
  const webRoot = join(dir, "dist");
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><p>shell</p>");
  database = createTestDatabase();
  logs = [];
  fake.server.use(
    http.post(
      `${FAKE_API_URL}/app-manifests/:code/conversions`,
      ({ params }) =>
        params.code === GOOD_CODE
          ? HttpResponse.json(converted, { status: 201 })
          : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
  );
});

afterEach(() => {
  fake.reset();
  database.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function build(env: Record<string, string> = {}) {
  const config: Config = loadConfig({
    ...validEnv,
    CROSSBOARD_DATA_DIR: database.dir,
    CROSSBOARD_GITHUB_API_URL: FAKE_API_URL,
    CROSSBOARD_GITHUB_WEB_URL: FAKE_WEB_URL,
    ...env,
  });
  const logger = createLogger("trace", { write: (chunk) => logs.push(chunk) });
  const setup = createSetup({ db: database.db, config, logger });
  const token = setup.start() ?? "";
  const github = createGithubClient({
    apiUrl: config.githubApiUrl,
    webUrl: config.githubWebUrl,
    logger,
  });
  const app = createApp({
    logger,
    db: database.db,
    github,
    installations: unusedInstallations,
    jobs: unusedJobs,
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
  return { app, config, token };
}

type App = ReturnType<typeof build>["app"];

const jsonHeaders = (cookie?: string): Record<string, string> => ({
  Origin: ORIGIN,
  "Content-Type": "application/json",
  ...(cookie === undefined ? {} : { Cookie: cookie }),
});

const cookiePair = (response: Response) =>
  (response.headers.getSetCookie()[0] ?? "").split("; ")[0] ?? "";

async function signIn(app: App, token: string) {
  const response = await app.request("/api/setup/token", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(204);
  return cookiePair(response);
}

const requestManifest = (app: App, cookie: string | undefined, body: unknown) =>
  app.request("/api/setup/manifest", {
    method: "POST",
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body),
  });

async function issueState(app: App, cookie: string) {
  const response = await requestManifest(app, cookie, {});
  const { state } = (await response.json()) as { state: string };
  return { cookie: cookiePair(response), state };
}

const callback = (app: App, cookie: string | undefined, query: string) =>
  app.request(`/setup/callback?${query}`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });

const storedRows = () =>
  database.db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, APP_CREDENTIALS_KEY))
    .all();

const conversions = () =>
  fake.requests.filter((request) => request.url.includes("/app-manifests/"));

describe("POST /api/setup/manifest", () => {
  it("returns the full manifest of FR-48 for a personal account", async () => {
    const { app, token } = build();
    const cookie = await signIn(app, token);
    const response = await requestManifest(app, cookie, {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { state: string };
    expect(body).toEqual({
      manifest: {
        name: "Crossboard (crossboard.example.com)",
        url: "https://crossboard.example.com",
        redirect_url: "https://crossboard.example.com/setup/callback",
        callback_urls: ["https://crossboard.example.com/auth/callback"],
        setup_url: "https://crossboard.example.com/settings",
        public: true,
        request_oauth_on_install: false,
        hook_attributes: {
          url: "https://crossboard.example.com/webhooks/github",
          active: true,
        },
        default_permissions: { issues: "read", metadata: "read" },
        default_events: [
          "issues",
          "issue_comment",
          "label",
          "sub_issues",
          "issue_dependencies",
          "repository",
        ],
      },
      url: `${FAKE_WEB_URL}/settings/apps/new`,
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
    });
  });

  it("targets the organization and takes a custom name", async () => {
    const { app, token } = build();
    const cookie = await signIn(app, token);
    const response = await requestManifest(app, cookie, {
      organization: "my-org",
      name: "  Team board  ",
    });
    const body = (await response.json()) as {
      manifest: { name: string };
      url: string;
    };
    expect(body.url).toBe(
      `${FAKE_WEB_URL}/organizations/my-org/settings/apps/new`,
    );
    expect(body.manifest.name).toBe("Team board");
  });

  it("marks the webhook inactive and drops a trailing slash with CROSSBOARD_WEBHOOKS=false", async () => {
    const { app, token } = build({
      CROSSBOARD_WEBHOOKS: "false",
      CROSSBOARD_PUBLIC_URL: "http://localhost:3000/",
    });
    const localOrigin = "http://localhost:3000";
    const signed = await app.request("/api/setup/token", {
      method: "POST",
      headers: { Origin: localOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const response = await app.request("/api/setup/manifest", {
      method: "POST",
      headers: {
        Origin: localOrigin,
        "Content-Type": "application/json",
        Cookie: cookiePair(signed),
      },
      body: "{}",
    });
    const { manifest } = (await response.json()) as {
      manifest: {
        url: string;
        redirect_url: string;
        hook_attributes: { url: string; active: boolean };
      };
    };
    expect(manifest.url).toBe("http://localhost:3000");
    expect(manifest.redirect_url).toBe("http://localhost:3000/setup/callback");
    expect(manifest.hook_attributes).toEqual({
      url: "http://localhost:3000/webhooks/github",
      active: false,
    });
  });

  it("stores the returned state in the setup cookie", async () => {
    const { app, token, config } = build();
    const first = await signIn(app, token);
    const { cookie, state } = await issueState(app, first);
    const probe = new Hono().get("/", async (c) =>
      c.json(await readSetupCookie(c, config)),
    );
    const read = await probe.request("/", { headers: { Cookie: cookie } });
    expect(await read.json()).toEqual({ state });
    const again = await issueState(app, cookie);
    expect(again.state).not.toBe(state);
    expect(cookie.startsWith(`${SETUP_COOKIE}=`)).toBe(true);
    const attributes = (await requestManifest(app, cookie, {})).headers
      .getSetCookie()[0]
      ?.split("; ");
    expect(attributes).toEqual(
      expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]),
    );
  });

  it("requires the setup cookie", async () => {
    const { app, token } = build();
    const cookie = await signIn(app, token);
    const forged = cookie.replace(/\.[^.]*$/, ".AAAA");
    for (const header of [undefined, forged, `${SETUP_COOKIE}=1`]) {
      const response = await requestManifest(app, header, {});
      expect(response.status, String(header)).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("applies the Origin and JSON checks", async () => {
    const { app, token } = build();
    const cookie = await signIn(app, token);
    const foreign = await app.request("/api/setup/manifest", {
      method: "POST",
      headers: { ...jsonHeaders(cookie), Origin: "https://evil.example.com" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const missing = await app.request("/api/setup/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    });
    expect(missing.status).toBe(403);
    const form = await app.request("/api/setup/manifest", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: "organization=x",
    });
    expect(form.status).toBe(415);
    for (const response of [foreign, missing, form]) {
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it.each([
    { organization: "a/b" },
    { organization: "../settings" },
    { organization: "-lead" },
    { organization: "" },
    { organization: "x".repeat(40) },
    { name: "" },
    { name: 5 },
  ])("rejects the invalid body %j", async (body) => {
    const { app, token } = build();
    const cookie = await signIn(app, token);
    const response = await requestManifest(app, cookie, body);
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /setup/callback", () => {
  it("answers 401 without a setup cookie, with no side effect", async () => {
    const { app, token } = build();
    const cookie = await signIn(app, token);
    const { state } = await issueState(app, cookie);
    const response = await callback(
      app,
      undefined,
      `code=${GOOD_CODE}&state=${state}`,
    );
    expect(response.status).toBe(401);
    expect(storedRows()).toEqual([]);
    expect(conversions()).toEqual([]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a missing, mismatched or never-issued state, with no side effect", async () => {
    const { app, token } = build();
    const tokenOnly = await signIn(app, token);
    const { cookie, state } = await issueState(app, tokenOnly);
    for (const [name, header, query, status] of [
      ["no state", cookie, `code=${GOOD_CODE}`, 400],
      ["empty state", cookie, `code=${GOOD_CODE}&state=`, 400],
      ["wrong state", cookie, `code=${GOOD_CODE}&state=${state}x`, 400],
      [
        "prefix of state",
        cookie,
        `code=${GOOD_CODE}&state=${state.slice(1)}`,
        400,
      ],
      ["no code", cookie, `state=${state}`, 400],
      ["no state issued", tokenOnly, `code=${GOOD_CODE}&state=${state}`, 400],
    ] as const) {
      const response = await callback(app, header, query);
      expect(response.status, name).toBe(status);
      expect(response.headers.get("set-cookie"), name).toBeNull();
    }
    expect(storedRows()).toEqual([]);
    expect(conversions()).toEqual([]);
    expect((await app.request("/setup")).status).toBe(200);
  });

  it("stores the converted credentials only as ciphertext and closes setup", async () => {
    const { app, token, config } = build();
    const first = await signIn(app, token);
    const { cookie, state } = await issueState(app, first);

    const response = await callback(
      app,
      cookie,
      `code=${GOOD_CODE}&state=${state}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/settings");
    expect(conversions()).toEqual([
      {
        method: "POST",
        url: `${FAKE_API_URL}/app-manifests/${GOOD_CODE}/conversions`,
      },
    ]);

    const rows = storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valueEnc.startsWith("v1:")).toBe(true);
    const everything = JSON.stringify(
      database.sqlite.prepare("SELECT * FROM app_config").all(),
    );
    for (const secret of secrets) {
      expect(everything).not.toContain(secret);
    }
    expect(JSON.parse(decrypt(rows[0]?.valueEnc ?? "", APP_SECRET))).toEqual({
      appId: "4242",
      appSlug: converted.slug,
      clientId: converted.client_id,
      clientSecret: converted.client_secret,
      privateKey: converted.pem,
      webhookSecret: converted.webhook_secret,
    });
    expect(
      resolveCredentials({
        db: database.db,
        config,
        logger: createLogger("silent"),
      }),
    ).toMatchObject({ appId: "4242", clientSecret: converted.client_secret });

    const exposed = [
      logs.join(""),
      await response.text(),
      JSON.stringify([...response.headers]),
    ].join("\n");
    for (const secret of secrets) {
      expect(exposed).not.toContain(secret);
    }
    expect(logs.join("")).toContain("credentials stored");
    expect(response.headers.getSetCookie()[0]).toMatch(
      new RegExp(`^${SETUP_COOKIE}=;`),
    );
  });

  it("answers 404 on every setup route afterwards, and serves /settings", async () => {
    const { app, token } = build();
    const first = await signIn(app, token);
    const { cookie, state } = await issueState(app, first);
    await callback(app, cookie, `code=${GOOD_CODE}&state=${state}`);

    for (const [method, path] of [
      ["GET", "/setup"],
      ["GET", "/setup/"],
      ["GET", "/setup/anything"],
      ["GET", `/setup/callback?code=${GOOD_CODE}&state=${state}`],
      ["POST", "/api/setup/token"],
      ["POST", "/api/setup/manifest"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: jsonHeaders(cookie),
        ...(method === "POST" ? { body: JSON.stringify({ token }) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    const settings = await app.request("/settings", {
      headers: { Cookie: startSession(database.db).cookie },
    });
    expect(settings.status).toBe(200);
    expect(conversions()).toHaveLength(1);
    expect(storedRows()).toHaveLength(1);
  });

  it("stores nothing and keeps setup open when GitHub rejects the code", async () => {
    const { app, token } = build();
    const first = await signIn(app, token);
    const { cookie, state } = await issueState(app, first);
    const response = await callback(app, cookie, `code=expired&state=${state}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_gateway" },
    });
    expect(storedRows()).toEqual([]);
    expect((await app.request("/setup")).status).toBe(200);
    const retry = await callback(
      app,
      cookie,
      `code=${GOOD_CODE}&state=${state}`,
    );
    expect(retry.status).toBe(302);
    expect(storedRows()).toHaveLength(1);
  });

  it("replaces stored credentials that can no longer be decrypted", async () => {
    database.db
      .insert(schema.appConfig)
      .values({
        key: APP_CREDENTIALS_KEY,
        valueEnc: encrypt("{}", "z".repeat(32)),
        updatedAt: 1,
      })
      .run();
    const { app, token, config } = build();
    expect(token).not.toBe("");
    const first = await signIn(app, token);
    const { cookie, state } = await issueState(app, first);
    const response = await callback(
      app,
      cookie,
      `code=${GOOD_CODE}&state=${state}`,
    );
    expect(response.status).toBe(302);
    expect(
      resolveCredentials({
        db: database.db,
        config,
        logger: createLogger("silent"),
      }),
    ).toMatchObject({ appId: "4242" });
  });

  it("does not overwrite credentials stored while the conversion was in flight", async () => {
    const { app, token, config } = build();
    const first = await signIn(app, token);
    const { cookie, state } = await issueState(app, first);
    fake.server.use(
      http.post(`${FAKE_API_URL}/app-manifests/:code/conversions`, () => {
        database.db
          .insert(schema.appConfig)
          .values({
            key: APP_CREDENTIALS_KEY,
            valueEnc: encrypt(
              JSON.stringify({
                appId: "1",
                appSlug: "other",
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
        return HttpResponse.json(converted, { status: 201 });
      }),
    );
    const response = await callback(
      app,
      cookie,
      `code=${GOOD_CODE}&state=${state}`,
    );
    expect(response.status).toBe(404);
    expect(
      resolveCredentials({
        db: database.db,
        config,
        logger: createLogger("silent"),
      }),
    ).toMatchObject({ appId: "1", appSlug: "other" });
  });
});

describe("credentials from the environment (FR-50)", () => {
  it("are returned by the accessor and close every setup route", async () => {
    const { app, config } = build(githubEnv);
    expect(
      resolveCredentials({
        db: database.db,
        config,
        logger: createLogger("silent"),
      }),
    ).toEqual({
      appId: githubEnv.GITHUB_APP_ID,
      appSlug: githubEnv.GITHUB_APP_SLUG,
      clientId: githubEnv.GITHUB_CLIENT_ID,
      clientSecret: githubEnv.GITHUB_CLIENT_SECRET,
      privateKey: githubEnv.GITHUB_PRIVATE_KEY,
      webhookSecret: githubEnv.GITHUB_WEBHOOK_SECRET,
    });
    for (const [method, path] of [
      ["GET", "/setup"],
      ["GET", "/setup/callback?code=x&state=y"],
      ["POST", "/api/setup/token"],
      ["POST", "/api/setup/manifest"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: jsonHeaders(),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(conversions()).toEqual([]);
  });

  it("take precedence over stored credentials", () => {
    const { config } = build(githubEnv);
    database.db
      .insert(schema.appConfig)
      .values({
        key: APP_CREDENTIALS_KEY,
        valueEnc: encrypt("{}", config.appSecret),
        updatedAt: 1,
      })
      .run();
    expect(
      resolveCredentials({
        db: database.db,
        config,
        logger: createLogger("silent"),
      })?.appId,
    ).toBe(githubEnv.GITHUB_APP_ID);
  });
});
