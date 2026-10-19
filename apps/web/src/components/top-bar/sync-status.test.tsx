import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Answer = () => Response | Promise<Response>;

const ME = {
  user: { login: "octocat", name: null, avatarUrl: "" },
  installations: [],
  installUrl: "https://github.com/apps/crossboard/installations/new",
};

const status = (syncedAt: number | null) =>
  Response.json({ syncedAt, repos: [], installations: [] });

function stubServer(options: { sync: Answer[]; refresh?: Answer }) {
  let syncCalls = 0;
  const mock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" || input instanceof URL ? input : input.url;
      const path = new URL(url, window.location.origin).pathname;
      if (path === "/api/me") return Response.json(ME);
      if (path === "/api/sync" && (init?.method ?? "GET") === "GET") {
        const answer = options.sync[
          Math.min(syncCalls, options.sync.length - 1)
        ] as Answer;
        syncCalls += 1;
        return answer();
      }
      if (path === "/api/sync/refresh" && init?.method === "POST") {
        return (options.refresh as Answer)();
      }
      return new Response(null, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const refreshCalls = (mock: ReturnType<typeof stubServer>) =>
  mock.mock.calls.filter(([input]) => String(input).endsWith("/sync/refresh"));

async function renderShell() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<App router={router} queryClient={queryClient} />);
  await screen.findByRole("banner");
}

const banner = () => screen.getByRole("banner");

describe("top bar sync status", () => {
  it("shows Synced with the oldest time as a time element", async () => {
    const syncedAt = Date.now() - 3 * 3_600_000;
    stubServer({ sync: [() => status(syncedAt)] });
    await renderShell();

    const time = await within(banner()).findByText("3 h ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe(
      new Date(syncedAt).toISOString(),
    );
    expect(banner().textContent).toContain("Synced 3 h ago");
  });

  it("does not claim a sync when no repo has synced", async () => {
    stubServer({ sync: [() => status(null)] });
    await renderShell();

    expect(await within(banner()).findByText("Not synced yet")).toBeTruthy();
    expect(banner().textContent).not.toContain("Synced ");
  });

  it("shows no time when the status request fails", async () => {
    stubServer({
      sync: [
        () =>
          Response.json({ error: { code: "internal_error" } }, { status: 500 }),
      ],
    });
    await renderShell();

    expect(
      await within(banner()).findByText("Sync status unavailable"),
    ).toBeTruthy();
    expect(banner().querySelector("time")).toBeNull();
    expect(banner().textContent).not.toContain("Synced ");
  });

  it("shows no time when the status request cannot reach the server", async () => {
    stubServer({ sync: [() => Promise.reject(new TypeError("network down"))] });
    await renderShell();

    expect(
      await within(banner()).findByText("Sync status unavailable"),
    ).toBeTruthy();
    expect(banner().textContent).not.toContain("Synced ");
  });

  it("refreshes through POST /api/sync/refresh as JSON, shows a spinner meanwhile and reloads the status", async () => {
    let finish: (response: Response) => void = () => {};
    const mock = stubServer({
      sync: [
        () => status(Date.now() - 3 * 3_600_000),
        () => status(Date.now() - 60_000),
      ],
      refresh: () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    });
    await renderShell();
    const button = await screen.findByRole("button", { name: "Refresh" });
    await within(banner()).findByText("3 h ago");

    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute("data-loading")).toBe(true));
    expect(
      button.querySelector("[data-slot=button-loading-indicator]"),
    ).toBeTruthy();
    expect(refreshCalls(mock)).toHaveLength(1);
    const [, init] = refreshCalls(mock)[0] as unknown as [unknown, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );

    finish(Response.json({ repos: 1 }, { status: 202 }));

    expect(await screen.findByText("Refresh queued")).toBeTruthy();
    expect(await within(banner()).findByText("1 min ago")).toBeTruthy();
    expect(button.hasAttribute("data-loading")).toBe(false);
  });

  it("shows the server's wait as a toast on 429 and keeps the shown time", async () => {
    stubServer({
      sync: [() => status(Date.now() - 3 * 3_600_000)],
      refresh: () =>
        Response.json(
          {
            error: {
              code: "rate_limited",
              message: "Refresh again in 40 s",
              retryAfter: 40,
            },
          },
          { status: 429 },
        ),
    });
    await renderShell();
    await within(banner()).findByText("3 h ago");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Refresh again in 40 s")).toBeTruthy();
    expect(screen.getByText("Could not refresh")).toBeTruthy();
    expect(screen.queryByText("Refresh queued")).toBeNull();
    expect(banner().textContent).toContain("Synced 3 h ago");
  });

  it("reports a refresh that cannot reach the server", async () => {
    stubServer({
      sync: [() => status(null)],
      refresh: () => Promise.reject(new TypeError("network down")),
    });
    await renderShell();
    await within(banner()).findByText("Not synced yet");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Could not refresh")).toBeTruthy();
    expect(screen.queryByText("Refresh queued")).toBeNull();
  });
});
