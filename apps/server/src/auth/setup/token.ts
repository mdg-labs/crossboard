import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { schema, type Db } from "../../db/index.js";
import { decrypt, encrypt } from "../../security/index.js";
import type { GithubManifestConversion } from "../../github/index.js";
import { resolveCredentials, storeCredentials } from "../credentials.js";
import type { Config } from "../../config/index.js";

export const SETUP_TOKEN_KEY = "setup_token_hash";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest();

export interface SetupOptions {
  db: Db;
  config: Pick<
    Config,
    "github" | "appSecret" | "publicUrl" | "webhooks" | "githubWebUrl"
  >;
  logger: Logger;
}

export interface Setup {
  /** True while no App credentials exist, in the environment or stored. */
  isRequired(): boolean;
  /**
   * Generates this start's setup token, replacing the stored hash, and logs
   * it. Does nothing (returns null) when the credentials already exist.
   */
  start(): string | null;
  verify(token: string): boolean;
  /** What the App manifest takes from the configuration. */
  readonly instance: {
    publicUrl: string;
    webhooks: boolean;
    githubWebUrl: string;
  };
  /**
   * Stores the converted App's credentials encrypted, which closes setup.
   * Returns false, writing nothing, when credentials exist already.
   */
  complete(app: GithubManifestConversion): boolean;
}

export function createSetup({ db, config, logger }: SetupOptions): Setup {
  // Credentials are only ever removed by the operator, who then restarts.
  let configured = false;

  const isRequired = () => {
    if (configured) {
      return false;
    }
    configured = resolveCredentials({ db, config, logger }) !== null;
    return !configured;
  };

  return {
    isRequired,

    instance: {
      publicUrl: config.publicUrl,
      webhooks: config.webhooks,
      githubWebUrl: config.githubWebUrl,
    },

    complete(app) {
      if (!isRequired()) {
        return false;
      }
      storeCredentials(
        { db, appSecret: config.appSecret },
        {
          appId: String(app.id),
          appSlug: app.slug,
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          privateKey: app.pem,
          webhookSecret: app.webhookSecret,
        },
      );
      return true;
    },

    start() {
      if (!isRequired()) {
        return null;
      }
      const token = randomBytes(32).toString("base64url");
      const valueEnc = encrypt(
        hashToken(token).toString("hex"),
        config.appSecret,
      );
      const updatedAt = Date.now();
      db.insert(schema.appConfig)
        .values({ key: SETUP_TOKEN_KEY, valueEnc, updatedAt })
        .onConflictDoUpdate({
          target: schema.appConfig.key,
          set: { valueEnc, updatedAt },
        })
        .run();
      logger.warn(
        { setupToken: token },
        `no GitHub App is configured; open ${config.publicUrl}/setup and enter this setup token`,
      );
      return token;
    },

    verify(token) {
      const row = db
        .select({ valueEnc: schema.appConfig.valueEnc })
        .from(schema.appConfig)
        .where(eq(schema.appConfig.key, SETUP_TOKEN_KEY))
        .get();
      if (row === undefined) {
        return false;
      }
      let stored: Buffer;
      try {
        stored = Buffer.from(decrypt(row.valueEnc, config.appSecret), "hex");
      } catch {
        return false;
      }
      const candidate = hashToken(token);
      return (
        stored.length === candidate.length && timingSafeEqual(stored, candidate)
      );
    },
  };
}
