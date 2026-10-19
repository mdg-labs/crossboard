import type { MiddlewareHandler } from "hono";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' https://avatars.githubusercontent.com https://*.githubusercontent.com https://github.com https://camo.githubusercontent.com data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self' https://github.com",
].join("; ");

/** Adds the Content-Security-Policy of SPEC §9.3 to every response. */
export function contentSecurityPolicy(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  };
}
