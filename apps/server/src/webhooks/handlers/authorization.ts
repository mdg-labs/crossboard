import { revokeUserByGithubId } from "../../auth/revoke.js";
import type { WebhookHandler, WebhookHandlersOptions } from "./index.js";
import { authorizationPayload } from "./payload.js";

/**
 * `github_app_authorization` (SPEC FR-7, §5.5): every action deletes the
 * tokens and sessions of the user the delivery's `sender` names. The delivery
 * carries no installation, so the user is found by GitHub id and nothing else
 * is touched.
 */
export function createAuthorizationHandler({
  db,
}: WebhookHandlersOptions): WebhookHandler {
  return (delivery) => {
    const parsed = authorizationPayload.safeParse(delivery.payload);
    if (!parsed.success) {
      delivery.logger.warn("webhook ignored: the payload names no user");
      return;
    }
    const revoked = revokeUserByGithubId(db, parsed.data.sender.id);
    delivery.logger.info({ revoked }, "app authorization revoked");
  };
}
