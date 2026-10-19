import { and, eq } from "drizzle-orm";
import {
  changeActiveSet,
  computeLiveSessionAccess,
  purgeInstallations,
  purgeRepos,
} from "../../access/index.js";
import { schema } from "../../db/index.js";
import { enqueueDiscovery } from "../../sync/discovery.js";
import { enqueueReconcile } from "../../sync/reconcile.js";
import type {
  WebhookDelivery,
  WebhookHandler,
  WebhookHandlersOptions,
} from "./index.js";
import {
  installationCreatedPayload,
  repositoriesRemovedPayload,
} from "./payload.js";

const { installations, repos } = schema;

/**
 * The handlers of `installation` and `installation_repositories` (SPEC §6.2).
 * Each acts on the installation the delivery names and nothing else; once the
 * installation's own data is applied, the access of every user with a live
 * session is recomputed (SPEC FR-8), which also derives the active set again
 * (SPEC FR-3). A failed recompute is logged and left to the hourly one: the
 * delivery's own change is already stored, and it is the part GitHub will not
 * repeat.
 */
export function createInstallationHandlers({
  db,
  jobs,
  access,
  allowlist,
}: WebhookHandlersOptions): Record<string, WebhookHandler> {
  const recompute = (delivery: WebhookDelivery) =>
    computeLiveSessionAccess(access, db, delivery.logger);

  const record = (
    delivery: WebhookDelivery,
    installation: ReturnType<
      typeof installationCreatedPayload.parse
    >["installation"],
  ) => {
    const at = Date.now();
    const fields = {
      accountLogin: installation.account.login,
      accountId: installation.account.id,
      accountType:
        installation.target_type === "Organization"
          ? ("Organization" as const)
          : ("User" as const),
      suspended: installation.suspended_at != null,
      updatedAt: at,
    };
    const { activated } = changeActiveSet(db, allowlist, (tx) => {
      tx.insert(installations)
        .values({ id: installation.id, createdAt: at, ...fields })
        .onConflictDoUpdate({ target: installations.id, set: fields })
        .run();
    });
    delivery.logger.info({ activated }, "installation recorded");
    for (const id of activated) enqueueDiscovery(jobs, id);
  };

  const setSuspended = (installationId: number, suspended: boolean) =>
    db
      .update(installations)
      .set({ suspended, updatedAt: Date.now() })
      .where(eq(installations.id, installationId))
      .run().changes > 0;

  return {
    async installation(delivery) {
      const installationId = delivery.installationId;
      if (installationId === undefined) {
        delivery.logger.warn(
          "webhook ignored: the payload names no installation",
        );
        return;
      }
      switch (delivery.action) {
        case "created": {
          const payload = installationCreatedPayload.safeParse(
            delivery.payload,
          );
          if (!payload.success) {
            delivery.logger.warn(
              "webhook ignored: the payload names no installation account",
            );
            return;
          }
          record(delivery, payload.data.installation);
          break;
        }
        case "deleted": {
          // The installation row goes too; its repos and access rows follow
          // through the foreign keys, after the purge has removed the
          // dependency rows that have none. Its links to users go with it,
          // which can leave other installations inactive (SPEC FR-3): the
          // change runs inside the active-set derivation.
          const { activated, deactivated } = changeActiveSet(
            db,
            allowlist,
            (tx) => {
              purgeInstallations(tx, [installationId]);
              tx.delete(installations)
                .where(eq(installations.id, installationId))
                .run();
            },
          );
          delivery.logger.info(
            { activated, deactivated },
            "installation deleted",
          );
          for (const id of activated) enqueueDiscovery(jobs, id);
          break;
        }
        case "suspend":
          setSuspended(installationId, true);
          break;
        case "unsuspend":
          if (setSuspended(installationId, false)) {
            enqueueDiscovery(jobs, installationId);
            for (const repo of db
              .select({ id: repos.id, installationId: repos.installationId })
              .from(repos)
              .where(
                and(
                  eq(repos.installationId, installationId),
                  eq(repos.syncState, "ready"),
                ),
              )
              .all()) {
              enqueueReconcile(jobs, repo);
            }
          }
          break;
        default:
          return;
      }
      await recompute(delivery);
    },

    async installation_repositories(delivery) {
      const installationId = delivery.installationId;
      if (installationId === undefined) {
        delivery.logger.warn(
          "webhook ignored: the payload names no installation",
        );
        return;
      }
      switch (delivery.action) {
        case "added":
          enqueueDiscovery(jobs, installationId);
          break;
        case "removed": {
          const payload = repositoriesRemovedPayload.safeParse(
            delivery.payload,
          );
          if (!payload.success) {
            delivery.logger.warn(
              "webhook ignored: the payload names no repository",
            );
            return;
          }
          const purged = db.transaction((tx) =>
            purgeRepos(
              tx,
              installationId,
              payload.data.repositories_removed.map((repo) => repo.node_id),
            ),
          );
          delivery.logger.info({ purged }, "removed repositories purged");
          break;
        }
        default:
          return;
      }
      await recompute(delivery);
    },
  };
}
