import { Webhooks } from "@octokit/webhooks";

/**
 * Checks a delivery's `X-Hub-Signature-256` header against the HMAC-SHA256 of
 * its raw body under the webhook secret (SPEC §7.1). A missing or malformed
 * header, an empty body or any verifier error does not match.
 */
export async function verifySignature(
  secret: string,
  body: string,
  header: string | undefined,
): Promise<boolean> {
  if (header === undefined || header === "" || body === "") return false;
  try {
    return await new Webhooks({ secret }).verify(body, header);
  } catch {
    return false;
  }
}
