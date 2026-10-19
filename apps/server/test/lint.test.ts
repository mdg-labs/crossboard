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

describe("octokit import lint rule", () => {
  const imports = [
    'import { Octokit } from "octokit";\nexport const value = Octokit;',
    'import { App } from "@octokit/app";\nexport const value = App;',
    'import type { RequestError } from "@octokit/request-error";\nexport type Value = RequestError;',
    'import { paginateRest } from "@octokit/plugin-paginate-rest/dist-src/index.js";\nexport const value = paginateRest;',
    'export { Octokit } from "octokit";',
    'import { Webhooks } from "@octokit/webhooks";\nexport const value = Webhooks;',
  ];

  it.each(imports)(
    "forbids %j outside apps/server/src/github/",
    async (code) => {
      for (const path of [
        "apps/server/src/example.ts",
        "apps/server/src/api/example.ts",
        "apps/server/test/example.ts",
      ]) {
        expect(await messages(code, path)).toContain("no-restricted-imports");
      }
    },
  );

  it.each(imports)("allows %j inside apps/server/src/github/", async (code) => {
    expect(await messages(code, "apps/server/src/github/example.ts")).toEqual(
      [],
    );
  });

  it("still forbids process.env imports inside apps/server/src/github/", async () => {
    expect(
      await messages(
        'import { env } from "node:process";\nexport const value = env.PORT;',
        "apps/server/src/github/example.ts",
      ),
    ).toContain("no-restricted-imports");
  });

  it("allows only @octokit/webhooks inside apps/server/src/webhooks/", async () => {
    const path = "apps/server/src/webhooks/example.ts";
    expect(
      await messages(
        'import { Webhooks } from "@octokit/webhooks";\nexport const value = Webhooks;',
        path,
      ),
    ).toEqual([]);
    expect(
      await messages(
        'import type { EmitterWebhookEvent } from "@octokit/webhooks/types";\nexport type Value = EmitterWebhookEvent;',
        path,
      ),
    ).toEqual([]);
    for (const code of [
      'import { Octokit } from "octokit";\nexport const value = Octokit;',
      'import { App } from "@octokit/app";\nexport const value = App;',
      'import { Octokit } from "@octokit/core";\nexport const value = Octokit;',
    ]) {
      expect(await messages(code, path)).toContain("no-restricted-imports");
    }
  });
});

describe("octokit dynamic import lint rule", () => {
  const code = (specifier: string) =>
    `export const value = import("${specifier}");`;

  it("forbids it outside apps/server/src/github/", async () => {
    for (const specifier of ["octokit", "@octokit/core", "@octokit/webhooks"]) {
      expect(
        await messages(code(specifier), "apps/server/src/example.ts"),
      ).toContain("no-restricted-syntax");
    }
  });

  it("allows it inside apps/server/src/github/", async () => {
    expect(
      await messages(code("@octokit/core"), "apps/server/src/github/x.ts"),
    ).toEqual([]);
  });

  it("allows only @octokit/webhooks inside apps/server/src/webhooks/", async () => {
    const path = "apps/server/src/webhooks/x.ts";
    expect(await messages(code("@octokit/webhooks"), path)).toEqual([]);
    expect(await messages(code("@octokit/core"), path)).toContain(
      "no-restricted-syntax",
    );
    expect(await messages(code("octokit"), path)).toContain(
      "no-restricted-syntax",
    );
  });
});
