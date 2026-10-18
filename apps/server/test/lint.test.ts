import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "../../..") });

async function messages(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.map((message) => message.ruleId) ?? [];
}

describe("process.env lint rule", () => {
  it.each([
    "export const value = process.env.PORT;",
    'export const value = process.env["PORT"];',
    "export const value = globalThis.process.env;",
    "const { env } = process;\nexport const value = env.PORT;",
    'import { env } from "node:process";\nexport const value = env.PORT;',
    'import process from "node:process";\nexport const value = process.env;',
  ])("forbids %j outside the config module", async (code) => {
    const rules = await messages(code, "apps/server/src/example.ts");
    expect(rules.length).toBeGreaterThan(0);
  });

  it("forbids it in server tests too", async () => {
    expect(
      await messages(
        "export const value = process.env.PORT;",
        "apps/server/test/example.ts",
      ),
    ).toContain("no-restricted-properties");
  });

  it("allows it inside apps/server/src/config/", async () => {
    expect(
      await messages(
        "export const value = process.env.PORT;",
        "apps/server/src/config/example.ts",
      ),
    ).toEqual([]);
  });
});
