import type { Page } from "@playwright/test";

/**
 * Collects every Content-Security-Policy violation the browser reports in the
 * console of `page`, so a test fails when the served CSP and the SPA disagree.
 */
export function watchCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}
