import { expect, test } from "../support/test.js";

test("an allowed user signs in and sees their installations on settings", async ({
  page,
  stack,
}) => {
  stack.fake.signInAs("octocat");

  await page.goto("/settings");

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("row", { name: /octocat\s+User\s+Active/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /acme\s+Organization\s+Active/ }),
  ).toBeVisible();
});

test("a user who is not allowed sees the not-allowed page and gets no session", async ({
  page,
  stack,
}) => {
  stack.fake.signInAs("mallory");

  await page.goto("/");

  await expect(page).toHaveURL(/\/auth\/not-allowed$/);
  await expect(
    page.getByText("This account is not allowed", { exact: true }),
  ).toBeVisible();
  const me = await page.request.get("/api/me");
  expect(me.status()).toBe(401);
  expect(await page.context().cookies()).toEqual([]);
});
