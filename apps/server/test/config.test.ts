import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/index.js";
import { githubEnv, SENTINEL, validEnv } from "./helpers.js";

function failure(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig defaults", () => {
  it("applies the SPEC 7.5 defaults", () => {
    expect(loadConfig(validEnv)).toEqual({
      publicUrl: "https://crossboard.example.com",
      appSecret: "a".repeat(32),
      allowedUsers: ["octocat"],
      allowedOrgs: [],
      dataDir: "/data",
      webhooks: true,
      reconcileIntervalMin: 15,
      port: 3000,
      logLevel: "info",
      github: null,
      githubApiUrl: "https://api.github.com",
      githubWebUrl: "https://github.com",
    });
  });

  it("parses every variable when set", () => {
    const config = loadConfig({
      ...validEnv,
      CROSSBOARD_ALLOWED_ORGS: "Acme",
      CROSSBOARD_DATA_DIR: "/srv/crossboard",
      CROSSBOARD_WEBHOOKS: "true",
      CROSSBOARD_RECONCILE_INTERVAL_MIN: "30",
      PORT: "8080",
      LOG_LEVEL: "debug",
      CROSSBOARD_GITHUB_API_URL: "http://localhost:4000/api",
      CROSSBOARD_GITHUB_WEB_URL: "http://localhost:4000",
    });
    expect(config).toMatchObject({
      allowedOrgs: ["acme"],
      dataDir: "/srv/crossboard",
      reconcileIntervalMin: 30,
      port: 8080,
      logLevel: "debug",
      githubApiUrl: "http://localhost:4000/api",
      githubWebUrl: "http://localhost:4000",
    });
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "",
      LOG_LEVEL: " ",
      CROSSBOARD_ALLOWED_ORGS: "",
    });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  it("defaults the reconcile interval to 2 without webhooks (FR-51)", () => {
    const config = loadConfig({ ...validEnv, CROSSBOARD_WEBHOOKS: "false" });
    expect(config.webhooks).toBe(false);
    expect(config.reconcileIntervalMin).toBe(2);
  });

  it("keeps an explicit reconcile interval without webhooks", () => {
    const config = loadConfig({
      ...validEnv,
      CROSSBOARD_WEBHOOKS: "false",
      CROSSBOARD_RECONCILE_INTERVAL_MIN: "5",
    });
    expect(config.reconcileIntervalMin).toBe(5);
  });
});

describe("loadConfig allowlists (FR-1)", () => {
  it("splits on commas, trims and lowercases", () => {
    const config = loadConfig({
      ...validEnv,
      CROSSBOARD_ALLOWED_USERS: " Octocat , Hubot,,",
      CROSSBOARD_ALLOWED_ORGS: "ACME, Widgets",
    });
    expect(config.allowedUsers).toEqual(["octocat", "hubot"]);
    expect(config.allowedOrgs).toEqual(["acme", "widgets"]);
  });

  it("accepts orgs alone", () => {
    const config = loadConfig({
      ...validEnv,
      CROSSBOARD_ALLOWED_USERS: "",
      CROSSBOARD_ALLOWED_ORGS: "acme",
    });
    expect(config.allowedUsers).toEqual([]);
  });

  it.each<Record<string, string>>([
    {},
    { CROSSBOARD_ALLOWED_USERS: " , ", CROSSBOARD_ALLOWED_ORGS: "," },
  ])("refuses to start when both allowlists are empty (%j)", (lists) => {
    const error = failure({
      ...validEnv,
      CROSSBOARD_ALLOWED_USERS: "",
      ...lists,
    });
    expect(error.message).toContain("CROSSBOARD_ALLOWED_USERS");
    expect(error.message).toContain("CROSSBOARD_ALLOWED_ORGS");
  });
});

describe("loadConfig validation", () => {
  it("requires the public URL and the app secret", () => {
    const error = failure({ CROSSBOARD_ALLOWED_USERS: "octocat" });
    expect(error.issues.map((issue) => issue.variable)).toEqual([
      "CROSSBOARD_PUBLIC_URL",
      "CROSSBOARD_APP_SECRET",
    ]);
  });

  it.each(["not a url", "ftp://example.com", "javascript:alert(1)"])(
    "rejects %j as the public URL",
    (value) => {
      const error = failure({ ...validEnv, CROSSBOARD_PUBLIC_URL: value });
      expect(error.issues).toEqual([
        expect.objectContaining({ variable: "CROSSBOARD_PUBLIC_URL" }),
      ]);
    },
  );

  it("rejects an app secret shorter than 32 characters", () => {
    const error = failure({
      ...validEnv,
      CROSSBOARD_APP_SECRET: "a".repeat(31),
    });
    expect(error.issues).toEqual([
      expect.objectContaining({ variable: "CROSSBOARD_APP_SECRET" }),
    ]);
  });

  it("accepts an app secret of exactly 32 characters", () => {
    expect(
      loadConfig({ ...validEnv, CROSSBOARD_APP_SECRET: "b".repeat(32) })
        .appSecret,
    ).toBe("b".repeat(32));
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "80a"],
    ["LOG_LEVEL", "verbose"],
    ["CROSSBOARD_WEBHOOKS", "yes"],
    ["CROSSBOARD_RECONCILE_INTERVAL_MIN", "0"],
    ["CROSSBOARD_RECONCILE_INTERVAL_MIN", "soon"],
    ["CROSSBOARD_GITHUB_API_URL", "api.github.com"],
    ["CROSSBOARD_GITHUB_WEB_URL", "github.com"],
  ])("rejects %s=%s", (variable, value) => {
    const error = failure({ ...validEnv, [variable]: value });
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
  });

  it("reports every invalid variable at once", () => {
    const error = failure({ ...validEnv, PORT: "x", LOG_LEVEL: "y" });
    expect(error.issues.map((issue) => issue.variable)).toEqual([
      "PORT",
      "LOG_LEVEL",
    ]);
  });

  it("names variables but never echoes values", () => {
    const error = failure({
      CROSSBOARD_PUBLIC_URL: `not a url ${SENTINEL}`,
      CROSSBOARD_APP_SECRET: SENTINEL.slice(0, 10),
      CROSSBOARD_ALLOWED_USERS: SENTINEL,
      CROSSBOARD_WEBHOOKS: SENTINEL,
      CROSSBOARD_RECONCILE_INTERVAL_MIN: SENTINEL,
      PORT: SENTINEL,
      LOG_LEVEL: SENTINEL,
      CROSSBOARD_GITHUB_API_URL: SENTINEL,
      CROSSBOARD_GITHUB_WEB_URL: SENTINEL,
      GITHUB_CLIENT_SECRET: SENTINEL,
    });
    const reported = JSON.stringify({
      message: error.message,
      issues: error.issues,
      stack: error.stack,
    });
    expect(error.issues.length).toBeGreaterThanOrEqual(10);
    expect(reported).not.toContain(SENTINEL);
    expect(reported).not.toContain(SENTINEL.slice(0, 10));
    expect(reported).toContain("CROSSBOARD_PUBLIC_URL");
    expect(reported).toContain("GITHUB_APP_ID");
  });
});

describe("loadConfig GitHub App credentials (FR-50)", () => {
  it("is null when none are set", () => {
    expect(loadConfig(validEnv).github).toBeNull();
  });

  it("returns all six when all are set", () => {
    expect(loadConfig({ ...validEnv, ...githubEnv }).github).toEqual({
      appId: "123",
      appSlug: "crossboard",
      clientId: "Iv1.abc",
      clientSecret: githubEnv.GITHUB_CLIENT_SECRET,
      privateKey: githubEnv.GITHUB_PRIVATE_KEY,
      webhookSecret: githubEnv.GITHUB_WEBHOOK_SECRET,
    });
  });

  it.each(Object.keys(githubEnv))("rejects a set without %s", (omitted) => {
    const partial = Object.fromEntries(
      Object.entries(githubEnv).filter(([name]) => name !== omitted),
    );
    const error = failure({ ...validEnv, ...partial });
    expect(error.issues.map((issue) => issue.variable)).toEqual([omitted]);
    expect(JSON.stringify(error.issues)).not.toContain(SENTINEL);
  });

  it("rejects a single credential", () => {
    const error = failure({ ...validEnv, GITHUB_APP_ID: "123" });
    expect(error.issues).toHaveLength(5);
  });

  it("counts an empty value as missing", () => {
    const error = failure({
      ...validEnv,
      ...githubEnv,
      GITHUB_PRIVATE_KEY: "  ",
    });
    expect(error.issues.map((issue) => issue.variable)).toEqual([
      "GITHUB_PRIVATE_KEY",
    ]);
  });
});
