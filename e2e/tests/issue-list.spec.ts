import type { Page } from "@playwright/test";
import { expect, test } from "../support/test.js";

const ROW_HEIGHT = 44;

const ISSUES = {
  banner: "Greeting banner is cut off on small screens",
  translate: "Translate the README to German",
  changelog: "Add a changelog",
  gauge: "Fuel gauge reads empty after launch",
  fuelLine: "Replace the fuel line",
};

test.beforeEach(async ({ page, stack }) => {
  stack.fake.signInAs("octocat");
  // The first visit signs in; discovery and the initial sync of the two
  // fixture repos then run in the background.
  await page.goto("/");
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/issues");
        return ((await response.json()) as { total?: number }).total;
      },
      { message: "both fixture repos are synced" },
    )
    .toBe(Object.keys(ISSUES).length);
  await page.reload();
});

const rows = (page: Page) => page.locator("tbody tr[data-issue-id]");

test("lists the open issues of both synced repos", async ({ page }) => {
  await expect(page.getByText("5 issues", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  for (const title of Object.values(ISSUES)) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }

  const gauge = rows(page).filter({ hasText: ISSUES.gauge });
  await expect(gauge.getByText("acme/rocket")).toBeVisible();
  await expect(gauge.getByText("Bug", { exact: true })).toBeVisible();
  await expect(gauge.getByText("blocked", { exact: true })).toBeVisible();
  await expect(gauge.getByText("blocked by 1")).toBeVisible();
  const fuelLine = rows(page).filter({ hasText: ISSUES.fuelLine });
  await expect(fuelLine.getByText("blocks 1")).toBeVisible();
  await expect(fuelLine.getByText("1/2")).toBeVisible();

  const heights = await rows(page).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  expect(heights).toEqual(heights.map(() => ROW_HEIGHT));
});

test("filters the list from the filter input and keeps it in the URL", async ({
  page,
}) => {
  const filter = page.getByRole("textbox", { name: "Filter issues" });

  await filter.fill("label:bug");
  await filter.press("Enter");

  await expect(page).toHaveURL(/\?q=label%3Abug$/);
  await expect(page.getByText("2 issues", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByText(ISSUES.banner)).toBeVisible();
  await expect(page.getByText(ISSUES.gauge)).toBeVisible();

  await page.reload();
  await expect(filter).toHaveValue("label:bug");
  await expect(rows(page)).toHaveCount(2);
});

test("underlines an invalid filter and keeps the last valid results", async ({
  page,
}) => {
  const filter = page.getByRole("textbox", { name: "Filter issues" });
  await filter.fill("repo:acme/rocket");
  await filter.press("Enter");
  await expect(rows(page)).toHaveCount(2);

  await filter.fill("repo:acme/rocket AND");

  await expect(page.locator("[data-error-range]")).toHaveText("AND");
  await expect(page.getByRole("alert")).toContainText(
    "AND must be between two terms",
  );
  await filter.press("Enter");
  await expect(page).toHaveURL(/\?q=repo%3Aacme%2Frocket$/);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByText(ISSUES.gauge)).toBeVisible();
});

test("a click on a label, an assignee or a repo narrows the filter", async ({
  page,
}) => {
  const filter = page.getByRole("textbox", { name: "Filter issues" });

  await rows(page)
    .filter({ hasText: ISSUES.translate })
    .getByRole("button", { name: "documentation" })
    .click();
  await expect(filter).toHaveValue('label:"documentation"');
  await expect(rows(page)).toHaveCount(1);

  await filter.fill("");
  await filter.press("Enter");
  await expect(rows(page)).toHaveCount(5);
  await rows(page)
    .filter({ hasText: ISSUES.gauge })
    .getByRole("button", { name: "acme/rocket" })
    .click();
  await expect(filter).toHaveValue("repo:acme/rocket");
  await expect(rows(page)).toHaveCount(2);

  await rows(page)
    .filter({ hasText: ISSUES.gauge })
    .getByTitle("Filter by assignee octocat")
    .click();
  await expect(filter).toHaveValue("repo:acme/rocket assignee:octocat");
  await expect(rows(page)).toHaveCount(1);
});

test("the list's keyboard shortcuts work and leave the filter alone", async ({
  page,
}) => {
  const filter = page.getByRole("textbox", { name: "Filter issues" });
  const selected = page.locator("tbody tr[aria-current=true]");
  await expect(rows(page)).toHaveCount(5);

  // Most recently updated first: fuel line, gauge, banner, translate, changelog.
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(selected).toHaveCount(1);
  await expect(selected).toContainText(ISSUES.gauge);
  await page.keyboard.press("k");
  await expect(selected).toContainText(ISSUES.fuelLine);

  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await page.keyboard.type("jko/");
  await expect(filter).toHaveValue("jko/");
  await expect(selected).toContainText(ISSUES.fuelLine);

  await filter.press("Home");
  await filter.press("ArrowRight");
  await page.keyboard.type("X");
  await expect(filter).toHaveValue("jXko/");
});
