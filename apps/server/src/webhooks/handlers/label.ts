import { and, eq, ne } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { WebhookHandler } from "./index.js";
import { labelPayload } from "./payload.js";

const { labels } = schema;

/**
 * `label` `edited` updates the label of the repo that the delivery names, and
 * `deleted` removes it (its rows on issues go with it); every other action
 * has no effect (SPEC §6.2). A label is only ever touched in the repo the
 * delivery names.
 */
export function createLabelHandler(db: Db): WebhookHandler {
  return (delivery) => {
    if (delivery.action !== "edited" && delivery.action !== "deleted") return;
    const parsed = labelPayload.safeParse(delivery.payload);
    if (!parsed.success) {
      delivery.logger.warn("webhook ignored: the payload names no label");
      return;
    }
    const { label, repository } = parsed.data;
    const here = and(
      eq(labels.id, label.node_id),
      eq(labels.repoId, repository.node_id),
    );

    if (delivery.action === "deleted") {
      db.delete(labels).where(here).run();
      return;
    }
    db.transaction((tx) => {
      if (
        tx.select({ id: labels.id }).from(labels).where(here).get() ===
        undefined
      ) {
        return;
      }
      const taken = tx
        .select({ id: labels.id })
        .from(labels)
        .where(
          and(
            eq(labels.repoId, repository.node_id),
            eq(labels.name, label.name),
            ne(labels.id, label.node_id),
          ),
        )
        .get();
      if (taken !== undefined) {
        // That label was renamed or deleted too; its own delivery frees the name.
        delivery.logger.warn(
          "label update skipped: another label of the repo holds the name",
        );
        return;
      }
      tx.update(labels)
        .set({
          name: label.name,
          color: label.color,
          description: label.description ?? null,
        })
        .where(here)
        .run();
    });
  };
}
