import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readServerVersion } from "../src/version.js";

const root = resolve(import.meta.dirname, "../../..");

function packageVersion(path: string): unknown {
  const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8")) as {
    version?: unknown;
  };
  return manifest.version;
}

describe("workspace version", () => {
  const rootVersion = packageVersion("package.json");

  it("is a release version declared by the root package", () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/query/package.json",
  ])("is the one %s declares", (path) => {
    expect(packageVersion(path)).toBe(rootVersion);
  });

  it("is the one the server reports", () => {
    expect(readServerVersion()).toBe(rootVersion);
  });
});
