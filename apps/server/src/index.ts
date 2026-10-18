import { ConfigError, loadConfig, type Config } from "./config/index.js";
import { createLogger } from "./logger.js";
import type { Logger } from "pino";

function bootstrap(): { config: Config; logger: Logger } {
  try {
    const config = loadConfig();
    return { config, logger: createLogger(config.logLevel) };
  } catch (error) {
    const logger = createLogger();
    if (error instanceof ConfigError) {
      logger.fatal({ issues: error.issues }, error.message);
    } else {
      logger.fatal({ err: error }, "failed to load the configuration");
    }
    process.exit(1);
  }
}

export const { config, logger } = bootstrap();

logger.info(
  { port: config.port, webhooks: config.webhooks },
  "crossboard configured",
);
