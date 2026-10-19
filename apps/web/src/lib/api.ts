import type { AppType } from "@crossboard/server";
import { hc } from "hono/client";

// A 401 from /api/setup/* means a wrong setup token, not a missing session.
const SETUP_API_PREFIX = "/api/setup/";

const requestPath = (input: RequestInfo | URL): string => {
  const url =
    typeof input === "string" || input instanceof URL ? input : input.url;
  return new URL(url, window.location.origin).pathname;
};

export function signInUrl(location: Pick<Location, "pathname" | "search">) {
  return `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;
}

/**
 * Sends the browser to sign-in when the server answers 401 (no session),
 * and still hands the response to the caller.
 */
export function withSignInRedirect(
  fetchImpl: typeof fetch,
  redirect: (url: string) => void = (url) => window.location.assign(url),
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (
      response.status === 401 &&
      !requestPath(input).startsWith(SETUP_API_PREFIX)
    ) {
      redirect(signInUrl(window.location));
    }
    return response;
  };
}

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Marks every state-changing request as JSON, which the server's CSRF guard
 * requires (SPEC §9.3) even when the request has no body, such as a `DELETE`.
 */
export function withJsonContentType(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (BODYLESS_METHODS.has(method)) {
      return fetchImpl(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetchImpl(input, { ...init, headers });
  };
}

export const api = hc<AppType>("/", {
  fetch: withSignInRedirect(
    withJsonContentType((input, init) => fetch(input, init)),
  ),
});
