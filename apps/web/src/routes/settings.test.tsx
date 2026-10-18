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

const INSTALL_URL = "https://github.com/apps/crossboard/installations/new";

const me = (
  installations: {
    id: number;
    accountLogin: string;
    accountType: "User" | "Organization";
    active: boolean;
  }[],
) => ({
  user: {
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
  installations,
  installUrl: INSTALL_URL,
});

function stubMe(...answers: (() => Response | Promise<Response>)[]) {
  let call = 0;
  const mock = vi.fn(async () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return (answer as () => Response | Promise<Response>)();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderSettings() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

describe("/settings", () => {
  it("shows a loading state while the request is pending", async () => {
    stubMe(() => new Promise<Response>(() => {}));
    renderSettings();

    expect(
      await screen.findByRole("status", { name: "Loading installations" }),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists the installations with their active flag and the install link", async () => {
    stubMe(() =>
      Response.json(
        me([
          {
            id: 1,
            accountLogin: "acme",
            accountType: "Organization",
            active: true,
          },
          {
            id: 2,
            accountLogin: "octocat",
            accountType: "User",
            active: false,
          },
        ]),
      ),
    );
    renderSettings();

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "acmeOrganizationActive",
      "octocatUserInactive",
    ]);
    const link = screen.getByRole("link", {
      name: /install on more accounts/i,
    });
    expect(link.getAttribute("href")).toBe(INSTALL_URL);
  });

  it("explains how to install the App when there are no installations", async () => {
    stubMe(() => Response.json(me([])));
    renderSettings();

    expect(
      await screen.findByText("The App is not installed anywhere yet"),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    const link = screen.getByRole("link", { name: /install the app/i });
    expect(link.getAttribute("href")).toBe(INSTALL_URL);
  });

  it("shows an error with a retry that loads the list again", async () => {
    const fetchMock = stubMe(
      () =>
        Response.json({ error: { code: "internal_error" } }, { status: 500 }),
      () =>
        Response.json(
          me([
            {
              id: 1,
              accountLogin: "acme",
              accountType: "Organization",
              active: true,
            },
          ]),
        ),
    );
    renderSettings();

    expect(
      await screen.findByText("Could not load your installations"),
    ).toBeTruthy();
    expect(
      screen.queryByText("The App is not installed anywhere yet"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("table")).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByText("Could not load your installations")).toBeNull();
  });

  it("shows the error state when the request cannot reach the server", async () => {
    stubMe(() => Promise.reject(new TypeError("network down")));
    renderSettings();

    expect(
      await screen.findByText("Could not load your installations"),
    ).toBeTruthy();
    expect(
      screen.queryByText("The App is not installed anywhere yet"),
    ).toBeNull();
  });
});
