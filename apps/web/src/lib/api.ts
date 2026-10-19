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

export const api = hc<AppType>("/", {
  fetch: withSignInRedirect((input, init) => fetch(input, init)),
});
