import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import type { IssueItem } from "@/lib/issues";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

const INSTALL_URL = "https://github.com/apps/crossboard/installations/new";
const VIEWPORT_HEIGHT = 600;

beforeEach(() => {
  // jsdom has no layout; the virtualizer reads the scroll container's size.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    VIEWPORT_HEIGHT,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Date.now();

function issue(n: number, overrides: Partial<IssueItem> = {}): IssueItem {
  return {
    id: `issue-${n}`,
    repo: { owner: "acme", name: "widgets" },
    number: n,
    title: `Issue number ${n}`,
    url: `https://github.com/acme/widgets/issues/${n}`,
    author: "octocat",
    type: null,
    milestone: null,
    labels: [],
    assignees: [],
    parent: null,
    subIssues: { total: 0, completed: 0 },
    blockedBy: { open: 0, notAccessible: 0 },
    blocking: { open: 0, notAccessible: 0 },
    isBlocked: false,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3 * 3_600_000,
    ...overrides,
  };
}

const installation = (active: boolean) => ({
  id: 1,
  accountLogin: "acme",
  accountType: "Organization" as const,
  active,
});

interface Stub {
  issues?: (url: URL) => Response | Promise<Response>;
  installations?: ReturnType<typeof installation>[];
}

function stubServer({ issues, installations = [installation(true)] }: Stub) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.pathname === "/api/me") {
      return Response.json({
        user: { login: "octocat", name: null, avatarUrl: "" },
        installations,
        installUrl: INSTALL_URL,
      });
    }
    if (url.pathname === "/api/issues" && issues !== undefined) {
      return issues(url);
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const page = (items: IssueItem[], total = items.length) =>
  Response.json({ items, total, warnings: [] });

function issueRequests(mock: ReturnType<typeof stubServer>): URL[] {
  return mock.mock.calls
    .map(([input]) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      return new URL(raw, window.location.origin);
    })
    .filter((url) => url.pathname === "/api/issues");
}

function renderList(initial = "/") {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter({ queryClient, history });
  render(<App queryClient={queryClient} router={router} />);
  return { router, history };
}

async function chooseSort(name: string) {
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

const dataRows = () =>
  document.querySelectorAll<HTMLElement>("tbody tr[data-issue-id]");

describe("the issue list on /", () => {
  it("renders 1,000 issues with fewer than 100 rows in the DOM", async () => {
    stubServer({
      issues: () =>
        page(
          Array.from({ length: 1000 }, (_, index) => issue(index + 1)),
          1000,
        ),
    });
    renderList();

    expect(await screen.findByText("Issue number 1")).toBeTruthy();
    expect(screen.getByText("1,000 issues")).toBeTruthy();
    expect(dataRows().length).toBeGreaterThan(0);
    expect(dataRows().length).toBeLessThan(100);
    expect(screen.queryByText("Issue number 500")).toBeNull();
  });

  it("loads the next 100 rows when the user scrolls near the end", async () => {
    const mock = stubServer({
      issues: (url) => {
        const offset = Number(url.searchParams.get("offset"));
        const count = Math.min(100, 250 - offset);
        return page(
          Array.from({ length: count }, (_, index) =>
            issue(offset + index + 1),
          ),
          250,
        );
      },
    });
    renderList();
    await screen.findByText("Issue number 1");
    expect(issueRequests(mock)).toHaveLength(1);
    expect(issueRequests(mock)[0]?.searchParams.get("limit")).toBe("100");

    const scroller = document.querySelector<HTMLElement>(
      "[data-slot=table-container]",
    ) as HTMLElement;
    scroller.scrollTop = 100 * 44;
    fireEvent.scroll(scroller);

    await waitFor(() => expect(issueRequests(mock)).toHaveLength(2));
    expect(issueRequests(mock)[1]?.searchParams.get("offset")).toBe("100");
    expect(await screen.findByText("Issue number 101")).toBeTruthy();
  });

  it("shows every column of an issue", async () => {
    stubServer({
      issues: () =>
        page([
          issue(7, {
            type: { name: "Bug", color: "RED" },
            labels: [
              { name: "frontend", color: "0e8a16" },
              { name: "odd", color: "not-a-color" },
            ],
            assignees: [
              { login: "ada", avatarUrl: "https://example.com/ada.png" },
            ],
            milestone: { title: "v1.0", url: "https://example.com/m/1" },
            blockedBy: { open: 1, notAccessible: 2 },
            blocking: { open: 0, notAccessible: 0 },
            isBlocked: true,
            subIssues: { total: 4, completed: 1 },
          }),
        ]),
    });
    renderList();

    const row = (await screen.findByText("Issue number 7")).closest(
      "tr",
    ) as HTMLElement;
    const cells = within(row);
    expect(cells.getByText("acme/widgets")).toBeTruthy();
    expect(cells.getByText("#7")).toBeTruthy();
    expect(cells.getByText("Bug").style.backgroundColor).toBe(
      "rgb(209, 36, 47)",
    );
    expect(cells.getByText("frontend").style.backgroundColor).toBe(
      "rgb(14, 138, 22)",
    );
    expect(cells.getByText("odd").style.backgroundColor).toBe(
      "rgb(110, 119, 129)",
    );
    expect(cells.getByText("A")).toBeTruthy();
    expect(cells.getByText("v1.0")).toBeTruthy();
    expect(cells.getByText("blocked")).toBeTruthy();
    expect(cells.getByText("blocked by 3")).toBeTruthy();
    expect(cells.queryByText(/^blocks/)).toBeNull();
    expect(cells.getByText("1/4")).toBeTruthy();
    expect(cells.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "1",
    );
    expect(cells.getByText("3 h ago")).toBeTruthy();
    const link = cells.getByRole("link", {
      name: "Open acme/widgets#7 on GitHub",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/issues/7",
    );
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("hides the dependency badges and progress that have nothing to show", async () => {
    stubServer({ issues: () => page([issue(8)]) });
    renderList();

    const row = (await screen.findByText("Issue number 8")).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).queryByText(/blocked|blocks/)).toBeNull();
    expect(within(row).queryByRole("progressbar")).toBeNull();
  });

  it("shows the absolute time in a tooltip", async () => {
    stubServer({ issues: () => page([issue(9)]) });
    renderList();

    const time = await screen.findByText("3 h ago");
    fireEvent.pointerEnter(time);
    fireEvent.mouseEnter(time);
    fireEvent.pointerMove(time);
    fireEvent.mouseMove(time);
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(NOW - 3 * 3_600_000);
    expect(
      await screen.findByText(expected, {}, { timeout: 3000 }),
    ).toBeTruthy();
  });

  it("shows skeleton rows while loading", async () => {
    stubServer({ issues: () => new Promise<Response>(() => {}) });
    renderList();

    const loading = await screen.findByRole("status", {
      name: "Loading issues",
    });
    expect(
      loading.querySelectorAll("[data-slot=skeleton]").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("explains an empty result and links to the install page without an active installation", async () => {
    stubServer({
      issues: () => page([]),
      installations: [installation(false)],
    });
    renderList();

    expect(
      await screen.findByText("No open issues match this filter"),
    ).toBeTruthy();
    const link = await screen.findByRole("link", { name: /Install the App/ });
    expect(link.getAttribute("href")).toBe(INSTALL_URL);
  });

  it("shows no install link when an installation is active", async () => {
    const mock = stubServer({ issues: () => page([]) });
    renderList();

    expect(
      await screen.findByText("No open issues match this filter"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        mock.mock.calls.some(([input]) => String(input).endsWith("/api/me")),
      ).toBe(true),
    );
    expect(screen.queryByRole("link", { name: /Install the App/ })).toBeNull();
  });

  it("shows an error with a retry that loads the list", async () => {
    let calls = 0;
    stubServer({
      issues: () => {
        calls += 1;
        return calls === 1
          ? Response.json(
              { error: { code: "internal", message: "boom" } },
              { status: 500 },
            )
          : page([issue(1)]);
      },
    });
    renderList();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load issues")).toBeTruthy();
    expect(within(alert).getByText("boom")).toBeTruthy();
    expect(screen.queryByText("No open issues match this filter")).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Issue number 1")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an error when the request is rejected", async () => {
    stubServer({
      issues: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderList();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Failed to fetch")).toBeTruthy();
  });

  it("restores the filter and sort from the URL and keeps them in the URL", async () => {
    const mock = stubServer({ issues: () => page([issue(1)]) });
    const { history } = renderList(
      "/?q=is%3Aopen%20label%3A%22bug%22&sort=title-asc",
    );

    await screen.findByText("Issue number 1");
    const request = issueRequests(mock)[0] as URL;
    expect(request.searchParams.get("q")).toBe('is:open label:"bug"');
    expect(request.searchParams.get("sort")).toBe("title-asc");
    const trigger = screen.getByRole("combobox", { name: "Sort issues" });
    expect(trigger.textContent).toContain("Title");

    fireEvent.click(trigger);
    await chooseSort("Newest");

    await waitFor(() =>
      expect(history.location.search).toContain("created-desc"),
    );
    expect(history.location.search).toContain("label");
    await waitFor(() =>
      expect(
        issueRequests(mock).some(
          (url) => url.searchParams.get("sort") === "created-desc",
        ),
      ).toBe(true),
    );
  });

  it("leaves the default sort out of the URL", async () => {
    stubServer({ issues: () => page([issue(1)]) });
    const { history } = renderList("/?sort=title-asc");

    await screen.findByText("Issue number 1");
    fireEvent.click(screen.getByRole("combobox", { name: "Sort issues" }));
    await chooseSort("Recently updated");

    await waitFor(() => expect(history.location.search).toBe(""));
  });
});
