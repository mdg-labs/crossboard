import type { Logger } from "pino";

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

/**
 * The handler of each webhook event name. A delivery whose event has no entry
 * here is acknowledged and dropped. Each event's handler is added by the item
 * that applies it.
 */
export const webhookHandlers: Readonly<Record<string, WebhookHandler>> = {};
