import type { Page } from "@playwright/test";
import { expect, test } from "../support/test.js";

const ISSUES = {
  banner: "Greeting banner is cut off on small screens",
  translate: "Translate the README to German",
  changelog: "Add a changelog",
  gauge: "Fuel gauge reads empty after launch",
  fuelLine: "Replace the fuel line",
};

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
    .toBe(Object.keys(ISSUES).length);
});

const column = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
const cards = (page: Page, name: string) =>
  column(page, name).locator("[data-issue-id]");

async function createBoard(page: Page): Promise<void> {
  await page.goto("/b/new");
  await page.getByLabel("Name", { exact: true }).fill("Triage");
  await page.getByLabel("Column 1 name").fill("Bugs");
  await page.getByLabel("Column 1 filter").fill("label:bug");
  await page.getByRole("button", { name: "Add column" }).click();
  await page.getByLabel("Column 2 name").fill("Docs");
  await page.getByLabel("Column 2 filter").fill("label:documentation");
  await page.getByRole("switch", { name: "Show an Other column" }).click();
  await page.getByRole("button", { name: "Create board" }).click();
  await expect(page).toHaveURL(/\/b\/\d+$/);
}

test("a new board places each issue in the first column that matches it", async ({
  page,
}) => {
  await createBoard(page);

  await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible();
  const headings = page.getByRole("heading", { level: 2 });
  await expect(headings).toHaveText(["Bugs", "Docs", "Other"]);

  await expect(cards(page, "Bugs")).toHaveCount(2);
  await expect(column(page, "Bugs").getByLabel("2 cards")).toBeVisible();
  await expect(column(page, "Bugs").getByText(ISSUES.gauge)).toBeVisible();
  await expect(column(page, "Bugs").getByText(ISSUES.banner)).toBeVisible();
  await expect(cards(page, "Docs")).toHaveCount(1);
  await expect(column(page, "Docs").getByText(ISSUES.translate)).toBeVisible();
  await expect(cards(page, "Other")).toHaveCount(2);
  await expect(column(page, "Other").getByText(ISSUES.changelog)).toBeVisible();
  await expect(column(page, "Other").getByText(ISSUES.fuelLine)).toBeVisible();

  const gauge = cards(page, "Bugs").filter({ hasText: ISSUES.gauge });
  await expect(gauge.getByText("acme/rocket")).toBeVisible();
  await expect(gauge.getByText("#1", { exact: true })).toBeVisible();
  await expect(gauge.getByText("Bug", { exact: true })).toBeVisible();
  await expect(gauge.getByText("blocked", { exact: true })).toBeVisible();
  const fuelLine = cards(page, "Other").filter({ hasText: ISSUES.fuelLine });
  await expect(fuelLine.getByText("1/2")).toBeVisible();
  await expect(
    gauge.getByRole("link", { name: "Open acme/rocket#1 on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/acme/rocket/issues/1");
});

test("a card opens the detail beside the board and Esc closes it", async ({
  page,
}) => {
  await createBoard(page);

  await column(page, "Bugs").getByText(ISSUES.gauge).click();

  const panel = page.locator("[data-detail-panel]");
  await expect(
    panel.getByRole("heading", { name: ISSUES.gauge }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/b\/\d+$/);
});

test("the filter bar and the repo picker narrow the board through ?q=", async ({
  page,
}) => {
  await createBoard(page);
  const boardPath = new URL(page.url()).pathname;
  const filter = page.getByRole("combobox", { name: "Filter issues" });
  await expect(cards(page, "Bugs")).toHaveCount(2);

  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await filter.fill("is:blocked");
  await filter.press("Enter");

  await expect(page).toHaveURL(
    `${new URL(page.url()).origin}${boardPath}?q=is%3Ablocked`,
  );
  await expect(cards(page, "Bugs")).toHaveCount(1);
  await expect(column(page, "Bugs").getByText(ISSUES.gauge)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Triage" })).toBeVisible();

  await filter.fill("");
  await filter.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${boardPath}$`));
  await expect(cards(page, "Bugs")).toHaveCount(2);

  const picker = page.getByRole("combobox", { name: "Repositories" });
  await picker.fill("acme/");
  await page.getByRole("option", { name: "acme/rocket" }).click();

  await expect(page).toHaveURL(/\?q=repo%3Aacme%2Frocket$/);
  await expect(filter).toHaveValue("repo:acme/rocket");
  await expect(page.getByLabel("acme/rocket", { exact: true })).toBeVisible();
  await expect(cards(page, "Bugs")).toHaveCount(1);
  await expect(column(page, "Bugs").getByText(ISSUES.gauge)).toBeVisible();
  await expect(cards(page, "Docs")).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("acme/rocket", { exact: true })).toBeVisible();
  await expect(cards(page, "Bugs")).toHaveCount(1);

  await page
    .getByLabel("acme/rocket", { exact: true })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${boardPath}$`));
  await expect(cards(page, "Bugs")).toHaveCount(2);
});

test("a board that does not exist is reported as not found", async ({
  page,
}) => {
  await page.goto("/b/999999");

  await expect(page.getByText("Board not found")).toBeVisible();
});
