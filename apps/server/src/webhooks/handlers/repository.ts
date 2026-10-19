import { and, eq, ne } from "drizzle-orm";
import { computeLiveSessionAccess, purgeRepos } from "../../access/index.js";
import { schema } from "../../db/index.js";
import { enqueueDiscovery } from "../../sync/discovery.js";
import type { WebhookHandler, WebhookHandlersOptions } from "./index.js";
import { repositoryPayload } from "./payload.js";

const { repos } = schema;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";

/**
 * The handler of `repository` (SPEC §6.2). Every write is bounded to the repo
 * of the installation that sent the delivery, so a delivery never changes a
 * repo another installation owns. A rename or transfer takes the new owner and
 * name from the payload, which describes the repository after the event, so
 * no GitHub call is needed.
 */
export function createRepositoryHandler({
  db,
  jobs,
  access,
}: WebhookHandlersOptions): WebhookHandler {
  return async (delivery) => {
    const installationId = delivery.installationId;
    if (installationId === undefined) {
      delivery.logger.warn(
        "webhook ignored: the payload names no installation",
      );
      return;
    }
    const parsed = repositoryPayload.safeParse(delivery.payload);
    if (!parsed.success) {
      delivery.logger.warn("webhook ignored: the payload names no repository");
      return;
    }
    const { repository } = parsed.data;
    const here = and(
      eq(repos.id, repository.node_id),
      eq(repos.installationId, installationId),
    );
    const at = Date.now();

    switch (delivery.action) {
      case "archived":
      case "deleted":
        db.transaction((tx) =>
          purgeRepos(tx, installationId, [repository.node_id]),
        );
        return;
      case "unarchived":
        db.update(repos)
          .set({ syncState: "pending", syncDetail: null, updatedAt: at })
          .where(and(here, ne(repos.syncState, "syncing")))
          .run();
        // Discovery decides the repo's state again and queues its sync, and
        // records the repo when it was purged while archived.
        enqueueDiscovery(jobs, installationId);
        return;
      case "renamed":
      case "transferred":
        try {
          db.update(repos)
            .set({
              owner: repository.owner.login,
              name: repository.name,
              updatedAt: at,
            })
            .where(here)
            .run();
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          delivery.logger.warn(
            "repository rename skipped: another stored repository holds the name",
          );
        }
        break;
      case "privatized":
      case "publicized":
        db.update(repos)
          .set({ private: delivery.action === "privatized", updatedAt: at })
          .where(here)
          .run();
        break;
      default:
        return;
    }
    await computeLiveSessionAccess(access, db, delivery.logger);
  };
}
