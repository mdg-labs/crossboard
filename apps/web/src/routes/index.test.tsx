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
import { details, summary } from "@/components/detail/test-data";
import { LEADING_WIDTH } from "@/components/issue-list/issue-table";
import type { IssueItem } from "@/lib/issues";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

const INSTALL_URL = "https://github.com/apps/crossboard/installations/new";
const VIEWPORT_HEIGHT = 600;

beforeEach(() => {
  window.sessionStorage.clear();
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
    const detail = /^\/api\/issues\/acme\/widgets\/(\d+)(\/details)?$/.exec(
      url.pathname,
    );
    if (detail !== null) {
      const n = Number(detail[1]);
      return Response.json(
        detail[2] === undefined
          ? summary({ number: n, title: `Detail of ${String(n)}` })
          : details({ bodyHtml: `<p>Body of issue ${String(n)}</p>` }),
      );
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

describe("nesting sub-issues", () => {
  const withChildren = (n: number, children: IssueItem[]) =>
    issue(n, {
      subIssues: { total: children.length, completed: 0 },
      children,
    });

  const at = (n: number) => ({ owner: "acme", repo: "widgets", number: n });

  const tree = () =>
    withChildren(1, [
      issue(2, { parent: at(1) }),
      {
        ...withChildren(3, [issue(4, { parent: at(3) })]),
        parent: at(1),
      },
    ]);

  const nested = (items: IssueItem[], total = items.length, matched = 4) =>
    Response.json({ items, total, matched, warnings: [] });

  const rowTitles = () =>
    [...dataRows()].map(
      (row) => row.querySelector("td:nth-child(3)")?.textContent,
    );

  it("asks for the flat list unless ?nest=1 is set", async () => {
    const mock = stubServer({ issues: () => page([issue(1)]) });
    renderList();
    await screen.findByText("Issue number 1");

    expect(issueRequests(mock)[0]?.searchParams.has("nest")).toBe(false);
    expect(screen.getByText("1 issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sub-issues of/ })).toBeNull();
  });

  it("lists one top-level row, and expanding it shows the child and then the grandchild", async () => {
    const mock = stubServer({ issues: () => nested([tree(), issue(9)], 2) });
    renderList("/?nest=1");

    await screen.findByText("Issue number 1");
    expect(issueRequests(mock)[0]?.searchParams.get("nest")).toBe("true");
    expect(screen.getByText("2 top-level issues · 4 matched")).toBeTruthy();
    expect(dataRows()).toHaveLength(2);
    expect(screen.queryByText("Issue number 2")).toBeNull();

    const toggle = screen.getByRole("button", {
      name: "Expand sub-issues of acme/widgets#1",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await screen.findByText("Issue number 2");
    expect(
      screen
        .getByRole("button", { name: "Collapse sub-issues of acme/widgets#1" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByText("Issue number 4")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-issues of acme/widgets#3",
      }),
    );
    expect(await screen.findByText("Issue number 4")).toBeTruthy();
    expect(rowTitles()).toEqual([
      "Issue number 1",
      "Issue number 2",
      "Issue number 3",
      "Issue number 4",
      "Issue number 9",
    ]);
    const indent = (title: string) =>
      (screen.getByText(title).closest("td") as HTMLElement).style.paddingLeft;
    expect(indent("Issue number 1")).toBe("");
    expect(indent("Issue number 2")).toBe("1.25rem");
    expect(indent("Issue number 4")).toBe("2.5rem");
  });

  it("keeps the expanded rows for the session", async () => {
    stubServer({ issues: () => nested([tree()], 1) });
    renderList("/?nest=1");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Expand sub-issues of acme/widgets#1",
      }),
    );
    await screen.findByText("Issue number 2");
    cleanup();

    renderList("/?nest=1");
    expect(await screen.findByText("Issue number 2")).toBeTruthy();
  });

  it("turns nesting on and off from the toolbar and carries it in the URL", async () => {
    const mock = stubServer({
      issues: (url) =>
        url.searchParams.has("nest") ? nested([tree()], 1) : page([issue(1)]),
    });
    const { history } = renderList("/?q=bug&sort=title-asc");
    await screen.findByText("Issue number 1");

    const nestSwitch = screen.getByRole("switch", { name: "Nest sub-issues" });
    expect(nestSwitch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(nestSwitch);
    await waitFor(() => expect(history.location.search).toContain("nest=1"));
    expect(history.location.search).toContain("title-asc");
    expect(history.location.search).toContain("bug");
    await screen.findByText("1 top-level issue · 4 matched");
    expect(issueRequests(mock).at(-1)?.searchParams.get("nest")).toBe("true");
    expect(issueRequests(mock).at(-1)?.searchParams.get("q")).toBe("bug");

    fireEvent.click(screen.getByRole("switch", { name: "Nest sub-issues" }));
    await waitFor(() => expect(history.location.search).not.toContain("nest"));
    await screen.findByText("1 issue");
  });

  it("keeps nesting when a qualifier is added from a row", async () => {
    stubServer({ issues: () => nested([tree()], 1) });
    const { history } = renderList("/?nest=1");
    const row = (await screen.findByText("Issue number 1")).closest(
      "tr",
    ) as HTMLElement;

    fireEvent.click(within(row).getByText("acme/widgets"));

    await waitFor(() => expect(history.location.search).toContain("repo"));
    expect(history.location.search).toContain("nest=1");
  });

  it("moves over the visible rows with j and k and opens the selected one with Enter", async () => {
    stubServer({ issues: () => nested([tree(), issue(9)], 2) });
    renderList("/?nest=1");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Expand sub-issues of acme/widgets#1",
      }),
    );
    await screen.findByText("Issue number 2");
    const selected = () =>
      document
        .querySelector("tr[aria-current='true']")
        ?.getAttribute("data-issue-id");

    fireEvent.keyDown(document.body, { key: "j" });
    expect(selected()).toBe("issue-1");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selected()).toBe("issue-2");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selected()).toBe("issue-3");
    fireEvent.keyDown(document.body, { key: "k" });
    expect(selected()).toBe("issue-2");

    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(
      await within(
        await waitFor(() => {
          const panel = document.querySelector<HTMLElement>(
            "[data-detail-panel]",
          );
          if (panel === null) throw new Error("no panel");
          return panel;
        }),
      ).findByRole("heading", { name: "Detail of 2" }),
    ).toBeTruthy();
  });

  it("shows loading, empty and error states in nesting mode", async () => {
    stubServer({ issues: () => new Promise<Response>(() => {}) });
    renderList("/?nest=1");
    expect(
      await screen.findByRole("status", { name: "Loading issues" }),
    ).toBeTruthy();
    cleanup();

    stubServer({ issues: () => nested([], 0, 0) });
    renderList("/?nest=1");
    expect(
      await screen.findByText("No open issues match this filter"),
    ).toBeTruthy();
    cleanup();

    stubServer({ issues: () => new Response(null, { status: 500 }) });
    renderList("/?nest=1");
    expect(await screen.findByText("Could not load issues")).toBeTruthy();
  });
});

describe("the parent of an issue", () => {
  const parentOf = (n: number) => ({
    owner: "acme",
    repo: "widgets",
    number: n,
  });

  it("is named below the title of a flat row, and opens its detail", async () => {
    stubServer({
      issues: () => page([issue(2, { parent: parentOf(5) }), issue(3)]),
    });
    renderList();

    const row = (await screen.findByText("Issue number 2")).closest(
      "tr",
    ) as HTMLElement;
    const hint = within(row).getByRole("button", { name: /acme\/widgets#5/ });
    expect(hint.textContent).toContain("↳");
    const other = screen
      .getByText("Issue number 3")
      .closest("tr") as HTMLElement;
    expect(within(other).queryByText(/↳/)).toBeNull();

    fireEvent.click(hint);
    expect(
      await screen.findByRole("heading", { name: "Detail of 5" }),
    ).toBeTruthy();
  });

  it("is left off a row nested right under it, but not off one whose parent is not listed", async () => {
    const child = issue(2, { parent: parentOf(1) });
    const stray = issue(3, { parent: parentOf(77) });
    stubServer({
      issues: () =>
        Response.json({
          items: [
            issue(1, {
              subIssues: { total: 1, completed: 0 },
              children: [child],
            }),
            { ...stray, children: [] },
          ],
          total: 2,
          matched: 3,
          warnings: [],
        }),
    });
    renderList("/?nest=1");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Expand sub-issues of acme/widgets#1",
      }),
    );

    const rowOf = (title: string) =>
      screen.getByText(title).closest("tr") as HTMLElement;
    await screen.findByText("Issue number 2");
    expect(within(rowOf("Issue number 2")).queryByText(/↳/)).toBeNull();
    expect(
      within(rowOf("Issue number 3")).getByText(/acme\/widgets#77/),
    ).toBeTruthy();
  });
});

describe("the nesting mode in the URL", () => {
  it("survives a filter submitted from the filter bar", async () => {
    stubServer({ issues: () => page([issue(1)]) });
    const { history } = renderList("/?nest=1");
    await screen.findByText("Issue number 1");

    const input = screen.getByRole("combobox", { name: /filter/i });
    fireEvent.input(input, {
      target: { value: "label:bug" },
      inputType: "insertText",
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(history.location.search).toContain("bug"));
    expect(history.location.search).toContain("nest=1");
  });
});

describe("blocked issues in the list", () => {
  const blocked = issue(1, {
    title: "Stuck",
    isBlocked: true,
    blockedBy: { open: 1, notAccessible: 2 },
  });
  const rowOf = (title: string) =>
    screen.getByText(title).closest("tr") as HTMLElement;

  it("marks a blocked row in its first cell with the number of blockers", async () => {
    stubServer({ issues: () => page([blocked, issue(2, { title: "Free" })]) });
    renderList();
    await screen.findByText("Stuck");

    const row = rowOf("Stuck");
    expect(row.getAttribute("data-blocked")).toBe("true");
    const first = row.querySelector("td:first-child") as HTMLElement;
    const marker = within(first).getByRole("img", { name: "Blocked by 3" });
    expect(first.contains(marker)).toBe(true);
    expect(
      marker.compareDocumentPosition(within(first).getByText("acme/widgets")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(row.className).toContain("data-blocked:*:first:shadow-");
    expect(within(row).getByText("blocked")).toBeTruthy();
  });

  it("says how many issues block it in a tooltip", async () => {
    stubServer({ issues: () => page([blocked]) });
    renderList();
    const marker = await screen.findByRole("img", { name: "Blocked by 3" });

    fireEvent.pointerEnter(marker);
    fireEvent.mouseEnter(marker);
    fireEvent.pointerMove(marker);
    fireEvent.mouseMove(marker);

    expect(
      await screen.findByText("Blocked by 3", {}, { timeout: 3000 }),
    ).toBeTruthy();
  });

  it("marks neither an issue that is not blocked nor one whose blockers are all closed", async () => {
    stubServer({
      issues: () =>
        page([
          issue(2, { title: "Free" }),
          issue(3, {
            title: "Blocks others",
            blocking: { open: 2, notAccessible: 0 },
          }),
          issue(4, { title: "Blockers closed" }),
        ]),
    });
    renderList();
    await screen.findByText("Free");

    for (const title of ["Free", "Blocks others", "Blockers closed"]) {
      expect(rowOf(title).hasAttribute("data-blocked")).toBe(false);
      expect(within(rowOf(title)).queryByRole("img")).toBeNull();
    }
  });
});

describe("the columns of the list", () => {
  it("lead with the columns that fit a 1024 px viewport", async () => {
    stubServer({ issues: () => page([issue(1)]) });
    renderList();
    await screen.findByText("Issue number 1");

    const headers = [...document.querySelectorAll("thead th")].map(
      (th) => th.textContent,
    );
    expect(headers.slice(0, 6)).toEqual([
      "Repository",
      "Issue",
      "Title",
      "Type",
      "Updated",
      "Open on GitHub",
    ]);
    expect(headers.slice(6)).toEqual([
      "Labels",
      "Assignees",
      "Milestone",
      "Dependencies",
      "Sub-issues",
    ]);
    expect(LEADING_WIDTH).toBeLessThanOrEqual(1024);
    const table = document.querySelector("table") as HTMLElement;
    expect(table.className).not.toContain("min-w-[1500px]");
    expect(Number.parseInt(table.style.minWidth, 10)).toBeGreaterThan(
      LEADING_WIDTH,
    );
    const cells = [
      ...(document.querySelector("tbody tr[data-issue-id]") as HTMLElement)
        .children,
    ];
    expect(cells).toHaveLength(headers.length);
    expect(cells[4]?.textContent).toBe("3 h ago");
  });

  it("gives a row a hover state that differs from the selected state", async () => {
    stubServer({ issues: () => page([issue(1), issue(2)]) });
    renderList();
    await screen.findByText("Issue number 1");

    fireEvent.keyDown(document.body, { key: "j" });
    const [selected, other] = [...dataRows()];
    expect(selected?.getAttribute("data-state")).toBe("selected");
    expect(other?.hasAttribute("data-state")).toBe(false);
    expect(other?.className).toContain("hover:bg-accent!");
    expect(selected?.className).toContain(
      "data-[state=selected]:bg-primary/10!",
    );
    expect(selected?.className).not.toContain(
      "data-[state=selected]:bg-accent",
    );
  });

  it("keeps o opening the selected issue on GitHub", async () => {
    stubServer({ issues: () => page([issue(1)]) });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderList();
    await screen.findByText("Issue number 1");

    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "o" });

    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/widgets/issues/1",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
