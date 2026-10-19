import type { Logger } from "pino";
import type { Db } from "../../db/index.js";
import type { Jobs } from "../../jobs/index.js";
import type { Refetch } from "../../sync/refetch.js";
import { createIssueHandlers } from "./issues.js";
import { createLabelHandler } from "./label.js";

/** What a handler is given about the delivery it applies. */
export interface WebhookDelivery {
  /** The `X-GitHub-Event` name. */
  event: string;
  action: string | undefined;
  deliveryId: string;
  installationId: number | undefined;
  /** The parsed payload; it is not logged by the intake past `debug`. */
  payload: unknown;
  /** Carries the event, action and ids; handlers log through it, never the payload. */
  logger: Logger;
}

export type WebhookHandler = (
  delivery: WebhookDelivery,
) => void | Promise<void>;

export interface WebhookHandlersOptions {
  db: Db;
  /** The queue that runs the debounced refetches; the handlers register their job on it. */
  jobs: Jobs;
  /** Removes and refetches issues by the SPEC §8.2 rules. */
  issues: Pick<Refetch, "refetch" | "remove">;
  /** How long a refetch waits for further deliveries about its issue; SPEC §6.2 says 5 s. */
  debounceMs?: number;
}

/**
 * The handler of each webhook event name. A delivery whose event has no entry
 * here is acknowledged and dropped. Creating the handlers registers their
 * refetch job on `jobs`, so it is done once per queue.
 */
export function createWebhookHandlers(
  options: WebhookHandlersOptions,
): Readonly<Record<string, WebhookHandler>> {
  return {
    ...createIssueHandlers(options),
    label: createLabelHandler(options.db),
  };
}
