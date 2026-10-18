import { ConfigError, loadConfig, type Config } from "./config/index.js";
import { openAndMigrate, type DatabaseHandle } from "./db/index.js";
import { createLogger } from "./logger.js";
import type { Logger } from "pino";

function bootstrap(): {
  config: Config;
  logger: Logger;
  database: DatabaseHandle;
} {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    const logger = createLogger();
    if (error instanceof ConfigError) {
      logger.fatal({ issues: error.issues }, error.message);
    } else {
      logger.fatal({ err: error }, "failed to load the configuration");
    }
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  try {
    const database = openAndMigrate(config.dataDir);
    logger.info({ path: database.path }, "database ready");
    return { config, logger, database };
  } catch (error) {
    logger.fatal(
      { err: error },
      "failed to open the database and apply migrations",
    );
    process.exit(1);
  }
}

export const { config, logger, database } = bootstrap();

logger.info(
  { port: config.port, webhooks: config.webhooks },
  "crossboard configured",
);
