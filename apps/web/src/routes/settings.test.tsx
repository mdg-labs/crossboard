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

type Answer = () => Response | Promise<Response>;

const NO_SYNC = {
  syncedAt: null,
  repos: [],
  installations: [],
};

/** Answers /api/me and /api/sync in turn; the last answer repeats. */
function stubApi(
  me: Answer[],
  sync: Answer[] = [() => Response.json(NO_SYNC)],
) {
  const calls = { me: 0, sync: 0 };
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const path = new URL(url, window.location.origin).pathname;
    const key = path === "/api/sync" ? "sync" : "me";
    const answers = key === "sync" ? sync : me;
    const answer = answers[Math.min(calls[key], answers.length - 1)] as Answer;
    calls[key] += 1;
    return answer();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const stubMe = (...answers: Answer[]) => stubApi(answers);

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

const repo = (
  name: string,
  state: "pending" | "syncing" | "ready" | "error" | "skipped",
  fields: { detail?: string | null; lastSyncedAt?: number | null } = {},
) => ({
  owner: "acme",
  name,
  state,
  detail: fields.detail ?? null,
  lastSyncedAt: fields.lastSyncedAt ?? null,
});

const okMe = () => Response.json(me([]));

describe("/settings sync state", () => {
  it("shows a loading state for the repositories and budgets while the request is pending", async () => {
    stubApi([okMe], [() => new Promise<Response>(() => {})]);
    renderSettings();

    expect(
      await screen.findByRole("status", { name: "Loading repositories" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Loading budgets" }),
    ).toBeTruthy();
  });

  it("lists every repo with a state badge, its last sync and its detail", async () => {
    stubApi(
      [okMe],
      [
        () =>
          Response.json({
            syncedAt: Date.now() - 5 * 60_000,
            repos: [
              repo("failing", "error", { detail: "GitHub answered 502" }),
              repo("fresh", "ready", { lastSyncedAt: Date.now() - 5 * 60_000 }),
              repo("pending", "pending"),
              repo("skipped", "skipped", { detail: "Repository is empty" }),
              repo("syncing", "syncing"),
            ],
            installations: [],
          }),
      ],
    );
    renderSettings();

    const table = (await screen.findAllByRole("table")).find((candidate) =>
      within(candidate).queryByText("Repository"),
    ) as HTMLElement;
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent);
    expect(rows).toEqual([
      "acme/failingErrorNeverGitHub answered 502",
      "acme/freshReady5 min ago",
      "acme/pendingPendingNever",
      "acme/skippedSkippedNeverRepository is empty",
      "acme/syncingSyncingNever",
    ]);
  });

  it("shows each active installation's budget in a card, unknown until reported", async () => {
    stubApi(
      [okMe],
      [
        () =>
          Response.json({
            syncedAt: null,
            repos: [],
            installations: [
              {
                id: 1,
                accountLogin: "acme",
                rest: {
                  remaining: 4000,
                  limit: 5000,
                  resetAt: 1_800_000_000_000,
                },
                graphql: null,
              },
              { id: 2, accountLogin: "octocat", rest: null, graphql: null },
            ],
          }),
      ],
    );
    renderSettings();

    const section = await screen.findByRole("region", {
      name: "GitHub budget",
    });
    const acme = (await within(section).findByText("acme")).closest(
      "[data-slot=card]",
    ) as HTMLElement;
    expect(acme.textContent).toContain("4,000 of 5,000 remaining, resets");
    expect(acme.textContent).toContain("GraphQL pointsUnknown");
    const octocat = within(section)
      .getByText("octocat")
      .closest("[data-slot=card]") as HTMLElement;
    expect(octocat.textContent).toContain("REST requestsUnknown");
    expect(octocat.textContent).toContain("GraphQL pointsUnknown");
  });

  it("explains an empty state for repositories and budgets", async () => {
    stubApi([okMe]);
    renderSettings();

    expect(await screen.findByText("No repositories yet")).toBeTruthy();
    expect(screen.getByText("No active installations")).toBeTruthy();
  });

  it("shows an error, not an empty table, when the sync request fails, and retries", async () => {
    stubApi(
      [okMe],
      [
        () =>
          Response.json({ error: { code: "internal_error" } }, { status: 500 }),
        () => Response.json({ ...NO_SYNC, repos: [repo("a", "ready")] }),
      ],
    );
    renderSettings();

    expect(
      await screen.findByText("Could not load the sync state"),
    ).toBeTruthy();
    expect(screen.getByText("Could not load the GitHub budgets")).toBeTruthy();
    expect(screen.queryByText("No repositories yet")).toBeNull();
    expect(screen.queryByText("No active installations")).toBeNull();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Retry" })[0] as HTMLElement,
    );

    expect(await screen.findByText("acme/a")).toBeTruthy();
    expect(screen.queryByText("Could not load the sync state")).toBeNull();
  });

  it("shows the error state when the sync request cannot reach the server", async () => {
    stubApi([okMe], [() => Promise.reject(new TypeError("network down"))]);
    renderSettings();

    expect(
      await screen.findByText("Could not load the sync state"),
    ).toBeTruthy();
    expect(screen.queryByText("No repositories yet")).toBeNull();
  });
});
