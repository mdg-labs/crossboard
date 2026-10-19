import { afterEach, describe, expect, it, vi } from "vitest";
import { api, signInUrl, withSignInRedirect } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("api client", () => {
  it("calls the server's typed routes", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ status: "ok", version: "1.2.3" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await api.api.health.$get();
    const body: { status: "ok"; version: string } = await response.json();
    expect(body).toEqual({ status: "ok", version: "1.2.3" });
    const request = fetchMock.mock.calls[0] as unknown as [string | URL];
    expect(String(request[0])).toMatch(/\/api\/health$/);
  });
});

describe("sign-in redirect on 401", () => {
  const unauthorized = () => Response.json({ error: {} }, { status: 401 });

  it("builds the sign-in URL from the current path and query", () => {
    expect(signInUrl({ pathname: "/boards/7", search: "?q=is:open" })).toBe(
      "/auth/login?return=%2Fboards%2F7%3Fq%3Dis%3Aopen",
    );
  });

  it("sends the browser to /auth/login?return=<current path> on a 401", async () => {
    window.history.replaceState(null, "", "/i/octocat/hello/42?tab=deps");
    const redirect = vi.fn();
    const call = withSignInRedirect(async () => unauthorized(), redirect);
    const response = await call("/api/me");
    expect(redirect).toHaveBeenCalledWith(
      "/auth/login?return=%2Fi%2Foctocat%2Fhello%2F42%3Ftab%3Ddeps",
    );
    expect(response.status).toBe(401);
  });

  it("redirects for a request given as a URL or a Request", async () => {
    const redirect = vi.fn();
    const call = withSignInRedirect(async () => unauthorized(), redirect);
    await call(new URL("/api/me", window.location.origin));
    await call(new Request(new URL("/api/me", window.location.origin)));
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it("leaves a 401 from /api/setup/* to the caller", async () => {
    const redirect = vi.fn();
    const call = withSignInRedirect(async () => unauthorized(), redirect);
    const response = await call("/api/setup/token", { method: "POST" });
    expect(response.status).toBe(401);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not redirect for other statuses", async () => {
    const redirect = vi.fn();
    for (const status of [200, 403, 404, 500]) {
      const call = withSignInRedirect(
        async () => new Response(null, { status }),
        redirect,
      );
      await call("/api/me");
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects through the shared client", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => unauthorized()),
    );
    await api.api.health.$get();
    expect(assign).toHaveBeenCalledWith("/auth/login?return=%2F");
  });
});
