import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config, GithubAppCredentials } from "../config/index.js";
import { schema, type Db } from "../db/index.js";
import { decrypt, encrypt } from "../security/index.js";

export const APP_CREDENTIALS_KEY = "github_app";

const storedCredentials = z.object({
  appId: z.string().min(1),
  appSlug: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});

export interface CredentialSources {
  db: Db;
  config: Pick<Config, "github" | "appSecret">;
  logger: Logger;
}

/**
 * The GitHub App credentials: the six `GITHUB_*` variables when set, else the
 * ones the setup flow stored in `app_config`, else nothing. Stored credentials
 * that cannot be decrypted (the secret changed) or read count as nothing, so
 * the operator is sent through setup again (SPEC §9.3).
 */
export function resolveCredentials({
  db,
  config,
  logger,
}: CredentialSources): GithubAppCredentials | null {
  if (config.github !== null) {
    return config.github;
  }
  const row = db
    .select({ valueEnc: schema.appConfig.valueEnc })
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, APP_CREDENTIALS_KEY))
    .get();
  if (row === undefined) {
    return null;
  }
  try {
    return storedCredentials.parse(
      JSON.parse(decrypt(row.valueEnc, config.appSecret)),
    );
  } catch {
    logger.warn(
      "the stored GitHub App credentials cannot be read; run the first-run setup again",
    );
    return null;
  }
}

/**
 * Stores the credentials encrypted in `app_config`, replacing a previous value
 * (which may be one that can no longer be decrypted).
 */
export function storeCredentials(
  { db, appSecret }: { db: Db; appSecret: string },
  credentials: GithubAppCredentials,
): void {
  const valueEnc = encrypt(JSON.stringify(credentials), appSecret);
  const updatedAt = Date.now();
  db.insert(schema.appConfig)
    .values({ key: APP_CREDENTIALS_KEY, valueEnc, updatedAt })
    .onConflictDoUpdate({
      target: schema.appConfig.key,
      set: { valueEnc, updatedAt },
    })
    .run();
}
