import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubEnv, SENTINEL, validEnv } from "./helpers.js";

let output: string[];
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  output = [];
  vi.resetModules();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubEnv(env: Record<string, string>) {
  for (const name of [
    ...Object.keys(validEnv),
    ...Object.keys(githubEnv),
    "LOG_LEVEL",
    "PORT",
  ]) {
    vi.stubEnv(name, "");
  }
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}

describe("process entry", () => {
  it("loads the config from the environment and creates the logger", async () => {
    stubEnv({ ...validEnv, PORT: "4321", LOG_LEVEL: "warn" });
    const entry = await import("../src/index.js");
    expect(entry.config.port).toBe(4321);
    expect(entry.logger.level).toBe("warn");
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs a JSON fatal naming the variables and exits when the config is invalid", async () => {
    stubEnv({
      ...validEnv,
      CROSSBOARD_APP_SECRET: SENTINEL.slice(0, 12),
      PORT: SENTINEL,
    });
    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    const record = JSON.parse(output.join(""));
    expect(record.level).toBe(60);
    expect(record.msg).toContain("CROSSBOARD_APP_SECRET");
    expect(record.msg).toContain("PORT");
    expect(output.join("")).not.toContain(SENTINEL.slice(0, 12));
  });

  it("exits when a GitHub App credential set is partial", async () => {
    stubEnv({ ...validEnv, GITHUB_APP_ID: "123" });
    await expect(import("../src/index.js")).rejects.toThrow("process.exit(1)");
    expect(output.join("")).toContain("GITHUB_PRIVATE_KEY");
  });
});
