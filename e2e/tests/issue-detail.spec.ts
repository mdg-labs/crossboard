import type { Page } from "@playwright/test";
import { expect, test } from "../support/test.js";

const GAUGE = "Fuel gauge reads empty after launch";
const FUEL_LINE = "Replace the fuel line";
const BANNER = "Greeting banner is cut off on small screens";

test.beforeEach(async ({ page, stack }) => {
  stack.fake.signInAs("octocat");
  await page.goto("/");
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/issues");
        return ((await response.json()) as { total?: number }).total;
      },
      { message: "both fixture repos are synced" },
    )
    .toBe(5);
  await page.reload();
  await expect(rows(page)).toHaveCount(5);
});

const rows = (page: Page) => page.locator("tbody tr[data-issue-id]");
const row = (page: Page, title: string) =>
  rows(page).filter({ hasText: title });
// A click on a label, an assignee or a repo narrows the filter instead.
const open = (page: Page, title: string) =>
  row(page, title).getByRole("cell", { name: title, exact: true }).click();
const drawer = (page: Page) => page.locator("[data-detail-panel]");

test("a row click opens the detail beside the list and Esc closes it", async ({
  page,
}) => {
  await open(page, GAUGE);

  const panel = drawer(page);
  await expect(panel.getByRole("heading", { name: GAUGE })).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "acme/rocket#1", exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("Bug", { exact: true })).toBeVisible();
  await expect(panel.getByText("The gauge shows")).toBeVisible();
  await expect(
    panel.locator(".markdown-body").getByText("empty", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Reproduced on the second launch."),
  ).toBeVisible();
  await expect(panel.getByText("Likely the fuel line.")).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Open on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/acme/rocket/issues/1");

  // Server-side sanitizing leaves nothing the page could run.
  await expect(panel.locator("script")).toHaveCount(0);
  await expect(panel.locator("[onclick]")).toHaveCount(0);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);

  // The list stays usable behind the panel: the gauge is the second row.
  await page.keyboard.press("k");
  await expect(row(page, FUEL_LINE)).toHaveAttribute("aria-current", "true");
  await expect(panel.getByRole("heading", { name: FUEL_LINE })).toBeVisible();
  await open(page, BANNER);
  await expect(panel.getByRole("heading", { name: BANNER })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("Enter opens the selected row", async ({ page }) => {
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");

  await expect(
    drawer(page).getByRole("heading", { name: FUEL_LINE }),
  ).toBeVisible();
});

test("a synced dependency opens its detail and lists sub-issues", async ({
  page,
}) => {
  await open(page, GAUGE);
  const blockedBy = drawer(page).getByRole("list", { name: "Blocked by" });
  await expect(blockedBy.getByText(FUEL_LINE)).toBeVisible();

  await blockedBy.getByRole("link", { name: "acme/rocket#2" }).click();

  await expect(
    drawer(page).getByRole("heading", { name: FUEL_LINE }),
  ).toBeVisible();
  const subIssues = drawer(page).getByRole("list", { name: "Sub-issues" });
  await expect(subIssues.getByText("Measure the old line")).toBeVisible();
  await expect(subIssues.getByText("Fit the new line")).toBeVisible();
});

test("/i/:owner/:repo/:number shows the same detail full-page", async ({
  page,
}) => {
  await page.goto("/i/acme/rocket/1");

  await expect(page.getByRole("heading", { name: GAUGE })).toBeVisible();
  await expect(page.getByText("The gauge shows")).toBeVisible();
  await expect(page.getByText("Likely the fuel line.")).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);

  await page.getByRole("link", { name: "acme/rocket#2", exact: true }).click();
  await expect(page).toHaveURL(/\/i\/acme\/rocket\/2$/);
  await expect(page.getByRole("heading", { name: FUEL_LINE })).toBeVisible();
});
