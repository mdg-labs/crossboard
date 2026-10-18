import { Hono } from "hono";
import { z } from "zod";
import { errorResponse, notFound } from "../../api/errors.js";
import { validate } from "../../api/validator.js";
import { requireSameOriginJson } from "../../security/index.js";
import { issueSetupCookie, type SetupCookieOptions } from "./cookie.js";
import type { Setup } from "./token.js";

export interface SetupRoutesOptions extends SetupCookieOptions {
  setup: Setup;
}

export function createSetupRoutes({
  setup,
  appSecret,
  publicUrl,
}: SetupRoutesOptions) {
  return new Hono().post(
    "/token",
    (c, next) => (setup.isRequired() ? next() : notFound(c)),
    requireSameOriginJson(publicUrl),
    validate("json", z.object({ token: z.string().min(1) })),
    async (c) => {
      const { token } = c.req.valid("json");
      if (!setup.verify(token)) {
        return errorResponse(c, 401, "unauthorized", "Invalid setup token");
      }
      await issueSetupCookie(c, { appSecret, publicUrl });
      return c.body(null, 204);
    },
  );
}
