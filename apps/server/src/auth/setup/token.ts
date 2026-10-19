import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { schema, type Db } from "../../db/index.js";
import { decrypt, encrypt } from "../../security/index.js";
import type { GithubManifestConversion } from "../../github/index.js";
import { resolveCredentials, storeCredentials } from "../credentials.js";
import type { Config, GithubAppCredentials } from "../../config/index.js";

export const SETUP_TOKEN_KEY = "setup_token_hash";
const SETUP_TOKEN_FILE = "setup-token";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest();

export interface SetupOptions {
  db: Db;
  config: Pick<
    Config,
    | "github"
    | "appSecret"
    | "publicUrl"
    | "webhooks"
    | "githubWebUrl"
    | "allowedUsers"
    | "allowedOrgs"
    | "dataDir"
  >;
  logger: Logger;
}

export interface Setup {
  /** True while no App credentials exist, in the environment or stored. */
  isRequired(): boolean;
  /**
   * Generates this start's setup token, replacing the stored hash, and writes
   * it to a 0600 file in the data directory, logging only the file's path.
   * Throws when the file cannot be written. With the credentials already
   * present it removes a leftover file and returns null.
   */
  start(): string | null;
  verify(token: string): boolean;
  /** What the App manifest takes from the configuration. */
  readonly instance: {
    publicUrl: string;
    webhooks: boolean;
    githubWebUrl: string;
  };
  /** The App credentials in effect now, else null while setup is required. */
  credentials(): GithubAppCredentials | null;
  /** `CROSSBOARD_ALLOWED_USERS` and `CROSSBOARD_ALLOWED_ORGS`, lowercased (FR-1). */
  readonly allowlist: {
    readonly users: readonly string[];
    readonly orgs: readonly string[];
  };
  /**
   * Stores the converted App's credentials encrypted, which closes setup, and
   * removes the setup token file.
   * Returns false, writing nothing, when credentials exist already.
   */
  complete(app: GithubManifestConversion): boolean;
}

export function createSetup({ db, config, logger }: SetupOptions): Setup {
  // Credentials are only ever removed by the operator, who then restarts.
  let configured = false;
  const tokenFile = join(config.dataDir, SETUP_TOKEN_FILE);

  // A file left behind holds a token that no longer opens anything.
  const removeTokenFile = () => {
    try {
      rmSync(tokenFile, { force: true });
    } catch (error) {
      logger.warn(
        { err: error, path: tokenFile },
        "the setup token file could not be removed",
      );
    }
  };

  // The temporary file is private from creation, and the rename replaces an
  // earlier token file in one step.
  const writeTokenFile = (token: string) => {
    const temporary = `${tokenFile}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, tokenFile);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  };

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

    credentials: () => resolveCredentials({ db, config, logger }),

    allowlist: { users: config.allowedUsers, orgs: config.allowedOrgs },

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
      removeTokenFile();
      return true;
    },

    start() {
      if (!isRequired()) {
        removeTokenFile();
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
      writeTokenFile(token);
      logger.warn(
        { path: tokenFile },
        `no GitHub App is configured; open ${config.publicUrl}/setup and enter the setup token from ${tokenFile}`,
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
