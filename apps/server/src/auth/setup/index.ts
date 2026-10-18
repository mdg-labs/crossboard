export { createSetupRoutes } from "./routes.js";
export { setupGate } from "./gate.js";
export { createSetup, SETUP_TOKEN_KEY, type Setup } from "./token.js";
export {
  hasValidSetupCookie,
  issueSetupCookie,
  SETUP_COOKIE,
  SETUP_COOKIE_TTL_SECONDS,
} from "./cookie.js";
