import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie } from "hono/cookie";
import type { Logger } from "pino";
import { z } from "zod";
import { errorResponse, notFound } from "../../api/errors.js";
import { validate } from "../../api/validator.js";
import { GithubError, type GithubClient } from "../../github/index.js";
import { requireSameOriginJson } from "../../security/index.js";
import {
  issueSetupCookie,
  readSetupCookie,
  SETUP_COOKIE,
  type SetupCookieOptions,
} from "./cookie.js";
import {
  buildManifest,
  defaultAppName,
  manifestTargetUrl,
} from "./manifest.js";
import type { Setup } from "./token.js";

export interface SetupRoutesOptions extends SetupCookieOptions {
  setup: Setup;
  github: GithubClient;
  logger: Logger;
}

const SETUP_TOKEN_MAX_BYTES = 4 * 1024;

const ORGANIZATION_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const manifestRequest = z.object({
  organization: z
    .string()
    .regex(ORGANIZATION_LOGIN, { error: "must be a GitHub organization login" })
    .optional(),
  name: z.string().trim().min(1).max(255).optional(),
});

const callbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const sameValue = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const whileRequired =
  (setup: Setup): MiddlewareHandler =>
  async (c, next) =>
    setup.isRequired() ? next() : notFound(c);

export function createSetupRoutes({
  setup,
  appSecret,
  publicUrl,
}: Pick<SetupRoutesOptions, "setup" | "appSecret" | "publicUrl">) {
  const cookieOptions = { appSecret, publicUrl };
  return new Hono()
    .use(whileRequired(setup))
    .post(
      "/token",
      requireSameOriginJson(publicUrl),
      bodyLimit({
        maxSize: SETUP_TOKEN_MAX_BYTES,
        onError: (c) =>
          errorResponse(
            c,
            413,
            "payload_too_large",
            "A setup token request is at most 4 KB",
          ),
      }),
      validate("json", z.object({ token: z.string().min(1) })),
      async (c) => {
        const { token } = c.req.valid("json");
        if (!setup.verify(token)) {
          return errorResponse(c, 401, "unauthorized", "Invalid setup token");
        }
        await issueSetupCookie(c, cookieOptions);
        return c.body(null, 204);
      },
    )
    .post(
      "/manifest",
      requireSameOriginJson(publicUrl),
      async (c, next) =>
        (await readSetupCookie(c, cookieOptions)) === null
          ? errorResponse(c, 401, "unauthorized", "Setup token required")
          : next(),
      validate("json", manifestRequest),
      async (c) => {
        const { organization, name } = c.req.valid("json");
        const state = randomBytes(32).toString("base64url");
        await issueSetupCookie(c, cookieOptions, Date.now(), state);
        return c.json({
          manifest: buildManifest(
            setup.instance,
            name ?? defaultAppName(setup.instance.publicUrl),
          ),
          url: manifestTargetUrl(setup.instance, organization),
          state,
        });
      },
    );
}

/** `GET /setup/callback`, where GitHub sends the operator back (SPEC FR-49). */
export function createSetupCallback({
  setup,
  github,
  logger,
  appSecret,
}: Pick<SetupRoutesOptions, "setup" | "github" | "logger" | "appSecret">) {
  return new Hono().get(
    "/",
    whileRequired(setup),
    async (c, next) =>
      (await readSetupCookie(c, { appSecret })) === null
        ? errorResponse(c, 401, "unauthorized", "Setup token required")
        : next(),
    validate("query", callbackQuery),
    async (c) => {
      const { code, state } = c.req.valid("query");
      const session = await readSetupCookie(c, { appSecret });
      if (session?.state === undefined || !sameValue(session.state, state)) {
        return errorResponse(c, 400, "invalid_state", "The state is invalid");
      }
      let app;
      try {
        app = await github.convertManifest(code);
      } catch (error) {
        if (error instanceof GithubError) {
          return errorResponse(
            c,
            502,
            "bad_gateway",
            `GitHub could not convert the manifest: ${error.githubMessage}`,
          );
        }
        throw error;
      }
      if (!setup.complete(app)) {
        return notFound(c);
      }
      deleteCookie(c, SETUP_COOKIE, { path: "/" });
      logger.info(
        { appId: app.id, appSlug: app.slug },
        "the GitHub App was created and its credentials stored",
      );
      return c.redirect("/settings", 302);
    },
  );
}
