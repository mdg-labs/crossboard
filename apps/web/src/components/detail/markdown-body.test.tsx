// @vitest-environment node
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({
  cwd: resolve(import.meta.dirname, "../../../../.."),
});

async function rules(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.map((message) => message.ruleId) ?? [];
}

const INJECT =
  "export const View = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n";

describe("the HTML injection lint rule", () => {
  it.each([
    ["JSX", INJECT],
    [
      "createElement props",
      'import { createElement } from "react";\nexport const view = (html: string) => createElement("div", { dangerouslySetInnerHTML: { __html: html } });\n',
    ],
    [
      "innerHTML",
      "export const put = (el: HTMLElement, html: string) => { el.innerHTML = html; };\n",
    ],
  ])("forbids %s anywhere but the markdown-body component", async (_, code) => {
    for (const path of [
      "apps/web/src/components/detail/issue-detail.tsx",
      "apps/web/src/routes/example.tsx",
      "apps/web/src/components/detail/markdown-body.test.tsx",
    ]) {
      expect(await rules(code, path)).toContain("no-restricted-syntax");
    }
  });

  it("allows it in components/detail/markdown-body.tsx", async () => {
    expect(
      await rules(INJECT, "apps/web/src/components/detail/markdown-body.tsx"),
    ).toEqual([]);
  });
});
