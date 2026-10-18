import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";
import type { Setup } from "./token.js";

const isSetupPath = (path: string) =>
  path === "/setup" ||
  path.startsWith("/setup/") ||
  path.startsWith("/api/setup/") ||
  path === "/api/health";

const isApiPath = (path: string) =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path.startsWith("/auth/") ||
  path.startsWith("/webhooks/");

function isStaticFile(webRoot: string, path: string): boolean {
  if (isApiPath(path)) return false;
  try {
    const segments = path.split("/").slice(1).map(decodeURIComponent);
    if (segments.some((s) => s === "." || s === ".." || /[/\\]/.test(s))) {
      return false;
    }
    const root = resolve(webRoot);
    const file = resolve(root, ...segments);
    return file.startsWith(root + sep) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * While the instance has no App credentials, only the setup routes, the
 * health endpoint and the web app's static files are served; everything else
 * redirects to `/setup` (SPEC FR-47). Mounted ahead of every other route.
 */
export function setupGate(setup: Setup, webRoot: string): MiddlewareHandler {
  return async (c, next) => {
    if (
      !setup.isRequired() ||
      isSetupPath(c.req.path) ||
      isStaticFile(webRoot, c.req.path)
    ) {
      return next();
    }
    return c.redirect("/setup", 302);
  };
}
