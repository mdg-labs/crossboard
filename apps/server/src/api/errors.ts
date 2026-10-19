import type { QueryError } from "@crossboard/query";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

const CODES: Partial<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  const body: ApiErrorBody = { error: { code, message } };
  return c.json(body, status);
}

/**
 * The `400` for a filter that does not parse, with the range to underline
 * (SPEC FR-18). `where` names the filter when a request carries several (a
 * board's base filter or one of its columns), and `field` is its path in the
 * request body.
 */
export function invalidQueryResponse(
  c: Context,
  error: QueryError,
  where?: { label: string; field: string },
) {
  const body: ApiErrorBody & {
    error: { start: number; end: number; field?: string };
  } = {
    error: {
      code: "invalid_query",
      message:
        where === undefined
          ? error.message
          : `${where.label}: ${error.message}`,
      start: error.start,
      end: error.end,
      ...(where === undefined ? {} : { field: where.field }),
    },
  };
  return c.json(body, 400);
}

export const notFound: NotFoundHandler = (c) =>
  errorResponse(c, 404, "not_found", "Not found");

export function createErrorHandler(logger: Logger): ErrorHandler {
  return (error, c) => {
    if (error instanceof HTTPException && error.status < 500) {
      return errorResponse(
        c,
        error.status as ContentfulStatusCode,
        CODES[error.status] ?? "bad_request",
        error.message || "Request failed",
      );
    }
    logger.error(
      { err: error, method: c.req.method, path: c.req.path },
      "request failed",
    );
    return errorResponse(c, 500, "internal_error", "Internal server error");
  };
}
