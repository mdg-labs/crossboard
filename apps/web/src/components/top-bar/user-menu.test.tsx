import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

const assign = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  assign.mockReset();
});

function stubServer(logout: () => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const path = new URL(url, window.location.origin).pathname;
    if (path === "/api/me") {
      return Response.json({
        user: { login: "octocat", name: null, avatarUrl: "" },
        installations: [],
        installUrl: "https://github.com/apps/crossboard/installations/new",
      });
    }
    if (path === "/auth/logout") {
      return logout();
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  vi.stubGlobal("location", { ...window.location, assign });
  return mock;
}

async function openMenu() {
  const queryClient = createQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<App router={router} queryClient={queryClient} />);
  const trigger = await screen.findByRole("button", { name: "User menu" });
  await screen.findByText("O");
  fireEvent.click(trigger);
  return router;
}

describe("user menu", () => {
  it("shows the signed-in login in the menu", async () => {
    stubServer(() => new Response(null, { status: 204 }));
    await openMenu();
    expect(await screen.findByText("octocat")).toBeTruthy();
  });

  it("signs out through POST /auth/logout and goes back to sign-in", async () => {
    const fetchMock = stubServer(() => new Response(null, { status: 204 }));
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/auth/login"));
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/auth/logout"),
    );
    const request = call as unknown as [RequestInfo | URL, RequestInit];
    expect(request[1].method).toBe("POST");
    expect(new Headers(request[1].headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("stays signed in and reports the failure when sign-out fails", async () => {
    stubServer(() => new Response(null, { status: 500 }));
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByText("Could not sign out")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("links to the settings page", async () => {
    stubServer(() => new Response(null, { status: 204 }));
    const router = await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
  });
});
