import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../api/errors.js";

/**
 * Guards a state-changing route against CSRF (SPEC §9.3): the request must
 * carry an `Origin` equal to the public URL's origin and a JSON body type.
 */
export function requireSameOriginJson(publicUrl: string): MiddlewareHandler {
  const expectedOrigin = new URL(publicUrl).origin;
  return async (c, next) => {
    if (c.req.header("origin") !== expectedOrigin) {
      return errorResponse(
        c,
        403,
        "forbidden",
        "The Origin header is missing or does not match this instance",
      );
    }
    const contentType = c.req.header("content-type");
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return errorResponse(
        c,
        415,
        "unsupported_media_type",
        "The request body must be application/json",
      );
    }
    await next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Applies {@link requireSameOriginJson} to every state-changing request, so a
 * route added later is protected without opting in. The webhook route is
 * exempt: its signature authenticates it (SPEC §9.3).
 */
export function protectStateChanges(publicUrl: string): MiddlewareHandler {
  const guard = requireSameOriginJson(publicUrl);
  return (c, next) =>
    SAFE_METHODS.has(c.req.method.toUpperCase()) ||
    c.req.path === "/webhooks/github"
      ? next()
      : guard(c, next);
}
