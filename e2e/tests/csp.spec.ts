import { expect, test } from "../support/test.js";
import { watchCspViolations } from "../support/csp.js";

test("a CSP violation reported in the console is collected", async ({
  browser,
  stack,
}) => {
  const context = await browser.newContext({ baseURL: stack.container.url });
  const page = await context.newPage();
  const violations = watchCspViolations(page);

  await page.goto("/auth/not-allowed");
  await expect(
    page.getByText("This account is not allowed", { exact: true }),
  ).toBeVisible();
  expect(violations).toEqual([]);

  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.injected = true";
    document.head.append(script);
  });

  await expect.poll(() => violations.length).toBe(1);
  expect(violations[0]).toMatch(/script-src/);
  await context.close();
});
