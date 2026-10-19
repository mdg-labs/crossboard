import { expect, test as base } from "@playwright/test";
import {
  APP_ID,
  CLIENT_ID,
  newAppKeys,
  newClientSecret,
  startContainer,
  type Container,
} from "./container.js";
import { watchCspViolations } from "./csp.js";
import { startFakeGithub, type FakeGithub } from "../fake-github/server.js";

export interface Stack {
  fake: FakeGithub;
  container: Container;
}

const isLoopback = (url: string) =>
  ["localhost", "127.0.0.1"].includes(new URL(url).hostname);

/**
 * `stack` is the fake GitHub plus the built image, started once per worker.
 * `page` fails its test on any CSP violation in the console and on any
 * request that leaves the machine (no test reaches the real GitHub).
 */
export const test = base.extend<{ stack: Stack }, { workerStack: Stack }>({
  workerStack: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern
    async ({}, use) => {
      const clientSecret = newClientSecret();
      const keys = newAppKeys();
      const fake = await startFakeGithub({
        clientId: CLIENT_ID,
        clientSecret,
        appId: APP_ID,
        appPublicKey: keys.publicKey,
      });
      let container: Container | undefined;
      try {
        container = await startContainer({
          image: process.env.CROSSBOARD_E2E_IMAGE ?? "crossboard:e2e",
          githubUrl: fake.url,
          clientSecret,
          appPrivateKey: keys.privateKey,
        });
        await use({ fake, container });
      } finally {
        await container?.stop();
        await fake.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
  stack: async ({ workerStack }, use) => {
    await use(workerStack);
  },
  baseURL: async ({ stack }, use) => {
    await use(stack.container.url);
  },
  page: async ({ page }, use) => {
    const violations = watchCspViolations(page);
    const external: string[] = [];
    await page.context().route(
      (url) => !isLoopback(url.toString()),
      (route) => {
        external.push(route.request().url());
        return route.abort();
      },
    );
    await use(page);
    expect(violations, "CSP violations in the browser console").toEqual([]);
    expect(external, "requests that left the machine").toEqual([]);
  },
});

export { expect };
