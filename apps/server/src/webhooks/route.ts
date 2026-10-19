import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { z } from "zod";
import { activeInstallationIds } from "../access/index.js";
import { errorResponse } from "../api/errors.js";
import type { Allowlist } from "../auth/sign-in/index.js";
import type { Db } from "../db/index.js";
import type { Jobs } from "../jobs/index.js";
import type { WebhookDelivery, WebhookHandler } from "./handlers/index.js";
import { verifySignature } from "./signature.js";

export const WEBHOOK_PATH = "/webhooks/github";

/** GitHub caps a webhook payload at 25 MB. */
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

/** The job that applies the deliveries of one event. */
export const webhookJobName = (event: string) => `webhook:${event}`;

/**
 * Events that may change the active set (SPEC FR-3, FR-8), so they are applied
 * even when their installation is not active yet.
 */
const ACTIVE_SET_EVENTS: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
]);

const payloadShape = z.looseObject({
  action: z.string().optional(),
  installation: z.looseObject({ id: z.number().int() }).optional(),
  repository: z.looseObject({ private: z.boolean().optional() }).optional(),
});

export interface WebhookRoutesOptions {
  db: Db;
  jobs: Jobs;
  logger: Logger;
  allowlist: Allowlist;
  /** The webhook secret in effect now, or null while none is configured. */
  webhookSecret: () => string | null;
  handlers: Readonly<Record<string, WebhookHandler>>;
}

const accepted = (c: { json: (body: object, status: 202) => Response }) =>
  c.json({ status: "accepted" }, 202);

/**
 * `POST /webhooks/github` (SPEC §6.2). The signature authenticates the
 * delivery, so the route is exempt from the session and CSRF checks. A valid
 * delivery is acknowledged with `202` and applied by the jobs interface under
 * the job `webhook:<event>`.
 */
export function createWebhookRoutes(options: WebhookRoutesOptions) {
  const { db, jobs, logger, allowlist, webhookSecret, handlers } = options;

  for (const [event, handler] of Object.entries(handlers)) {
    jobs.register<Omit<WebhookDelivery, "logger">>(
      webhookJobName(event),
      async (delivery) => {
        await handler({
          ...delivery,
          logger: logger.child({
            event: delivery.event,
            action: delivery.action,
            delivery: delivery.deliveryId,
            installationId: delivery.installationId,
          }),
        });
      },
    );
  }

  const limitBody = bodyLimit({
    maxSize: MAX_PAYLOAD_BYTES,
    onError: (c) =>
      errorResponse(
        c,
        413,
        "payload_too_large",
        "A webhook payload is at most 25 MB",
      ),
  });

  return new Hono().post("/", limitBody, async (c) => {
    const secret = webhookSecret();
    const body = await c.req.text();
    if (
      secret === null ||
      !(await verifySignature(
        secret,
        body,
        c.req.header("x-hub-signature-256"),
      ))
    ) {
      return errorResponse(
        c,
        401,
        "unauthorized",
        "The webhook signature is missing or invalid",
      );
    }

    const event = c.req.header("x-github-event");
    const deliveryId = c.req.header("x-github-delivery");
    if (event === undefined || deliveryId === undefined) {
      return errorResponse(
        c,
        400,
        "bad_request",
        "The X-GitHub-Event and X-GitHub-Delivery headers are required",
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return errorResponse(c, 400, "bad_request", "The body is not valid JSON");
    }
    const parsed = payloadShape.safeParse(json);
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "bad_request",
        "The body is not a webhook payload",
      );
    }
    const { action, installation, repository } = parsed.data;
    const installationId = installation?.id;
    const ids = { event, action, delivery: deliveryId, installationId };

    if (repository?.private === false) {
      logger.debug({ ...ids, payload: json }, "webhook payload");
    }

    if (!Object.hasOwn(handlers, event)) {
      logger.debug(ids, "webhook dropped: no handler for the event");
      return accepted(c);
    }
    if (
      installationId !== undefined &&
      !ACTIVE_SET_EVENTS.has(event) &&
      !activeInstallationIds(db, allowlist).has(installationId)
    ) {
      logger.debug(ids, "webhook dropped: the installation is not active");
      return accepted(c);
    }

    const delivery: Omit<WebhookDelivery, "logger"> = {
      event,
      action,
      deliveryId,
      installationId,
      payload: json,
    };
    const queued = jobs.enqueue(webhookJobName(event), delivery, {
      installationId,
    });
    if (!queued && !jobs.started) {
      logger.warn(ids, "webhook not applied: the job queue is stopped");
      return errorResponse(
        c,
        503,
        "unavailable",
        "The server is shutting down; redeliver the webhook",
      );
    }
    logger.info(ids, "webhook accepted");
    return accepted(c);
  });
}
