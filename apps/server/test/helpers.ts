import type { InstallationClient } from "../src/github/index.js";
import { createJobs } from "../src/jobs/index.js";
import { createLogger } from "../src/logger.js";

export const SENTINEL = "sentinel-secret-value-7f3a9c1e5d2b4a68";

export const validEnv = {
  CROSSBOARD_PUBLIC_URL: "https://crossboard.example.com",
  CROSSBOARD_APP_SECRET: "a".repeat(32),
  CROSSBOARD_ALLOWED_USERS: "octocat",
};

export const githubEnv = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "crossboard",
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: `client-${SENTINEL}`,
  GITHUB_PRIVATE_KEY: `key-${SENTINEL}`,
  GITHUB_WEBHOOK_SECRET: `hook-${SENTINEL}`,
};

export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/**
 * An installation client for apps whose routes under test never call GitHub as
 * an installation; a call fails the test.
 */
export const unusedInstallations: Pick<
  InstallationClient,
  "budgets" | "graphql"
> = {
  budgets: { get: () => ({ rest: null, graphql: null }) },
  graphql: () =>
    Promise.reject(new Error("the test did not expect an installation call")),
};

/** A job queue for apps whose routes under test enqueue nothing. */
export const unusedJobs = createJobs({ logger: createLogger("silent") });
