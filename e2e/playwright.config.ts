import { defineConfig } from "@playwright/test";

// Every test shares one container and one fake GitHub per worker, so the
// tests run one after another.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "retain-on-failure" },
  outputDir: "test-results",
});
