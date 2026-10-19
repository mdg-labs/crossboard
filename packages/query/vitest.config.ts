import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node" },
      },
      {
        extends: true,
        test: { name: "browser-like", environment: "jsdom" },
      },
    ],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { branches: 90 },
    },
  },
});
