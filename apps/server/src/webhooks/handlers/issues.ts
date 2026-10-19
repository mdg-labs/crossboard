import { eq } from "drizzle-orm";
import type { z } from "zod";
import { schema } from "../../db/index.js";
import type {
  WebhookDelivery,
  WebhookHandler,
  WebhookHandlersOptions,
} from "./index.js";
import {
  dependenciesPayload,
  issuePayload,
  subIssuesPayload,
} from "./payload.js";

const { issueDetails } = schema;

export const REFETCH_JOB = "webhook.refetch-issue";

/** SPEC §6.2: a refetch waits this long, so a burst of deliveries costs one. */
export const REFETCH_DEBOUNCE_MS = 5_000;

interface Refetching {
  id: string;
  /** The installation that delivered the event, to fetch an issue not stored yet. */
  installationId: number | undefined;
}

/**
 * The handlers of the issue events (SPEC §6.2). `issues` `closed`, `deleted`
 * and `transferred` remove the issue through the one removal every path uses;
 * every other delivery that names an issue enqueues a refetch of it, keyed by
 * the issue so deliveries within the debounce window share one.
 */
export function createIssueHandlers({
  db,
  jobs,
  issues,
  debounceMs = REFETCH_DEBOUNCE_MS,
}: WebhookHandlersOptions): Record<string, WebhookHandler> {
  jobs.register<Refetching>(REFETCH_JOB, async ({ id, installationId }) => {
    await issues.refetch([id], installationId);
  });

  const refetch = (delivery: WebhookDelivery, id: string) => {
    const installationId = delivery.installationId;
    jobs.enqueue(REFETCH_JOB, { id, installationId } satisfies Refetching, {
      key: id,
      delayMs: debounceMs,
      installationId,
    });
  };

  /** Parses the payload, or logs that the delivery names nothing to apply. */
  const parse = <T extends z.ZodType>(
    delivery: WebhookDelivery,
    shape: T,
  ): z.infer<T> | undefined => {
    const parsed = shape.safeParse(delivery.payload);
    if (!parsed.success) {
      delivery.logger.warn("webhook ignored: the payload names no issue");
      return undefined;
    }
    return parsed.data as z.infer<T>;
  };

  return {
    async issues(delivery) {
      const payload = parse(delivery, issuePayload);
      if (payload === undefined) return;
      const id = payload.issue.node_id;
      switch (delivery.action) {
        case "closed":
          await issues.remove([id], "closed");
          return;
        case "deleted":
        case "transferred":
          await issues.remove([id], "gone");
          return;
        case undefined:
          return;
        default:
          refetch(delivery, id);
      }
    },

    sub_issues(delivery) {
      const payload = parse(delivery, subIssuesPayload);
      if (payload === undefined) return;
      for (const issue of [payload.parent_issue, payload.sub_issue]) {
        if (issue !== undefined) refetch(delivery, issue.node_id);
      }
    },

    issue_dependencies(delivery) {
      const payload = parse(delivery, dependenciesPayload);
      if (payload === undefined) return;
      for (const issue of [payload.blocked_issue, payload.blocking_issue]) {
        if (issue !== undefined) refetch(delivery, issue.node_id);
      }
    },

    issue_comment(delivery) {
      const payload = parse(delivery, issuePayload);
      if (payload === undefined) return;
      db.delete(issueDetails)
        .where(eq(issueDetails.issueId, payload.issue.node_id))
        .run();
    },
  };
}
