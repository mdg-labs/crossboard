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
import { details, relation, summary } from "@/components/detail/test-data";
import type { IssueItem } from "@/lib/issues";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Date.now();

function item(n: number): IssueItem {
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
    updatedAt: NOW - 3_600_000,
  };
}

function stubServer() {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const { pathname } = new URL(raw, window.location.origin);
    if (pathname === "/api/me") {
      return Response.json({
        user: { login: "octocat", name: null, avatarUrl: "" },
        installations: [],
        installUrl: "https://github.com/apps/crossboard/installations/new",
      });
    }
    if (pathname === "/api/issues") {
      return Response.json({
        items: [item(1), item(2), item(3)],
        total: 3,
        warnings: [],
      });
    }
    const match = /^\/api\/issues\/acme\/widgets\/(\d+)(\/details)?$/.exec(
      pathname,
    );
    if (match !== null) {
      const n = Number(match[1]);
      if (match[2] !== undefined) {
        return Response.json(
          details({ bodyHtml: `<p>Body of issue ${String(n)}</p>` }),
        );
      }
      return Response.json(
        summary({
          id: `issue-${String(n)}`,
          number: n,
          url: `https://github.com/acme/widgets/issues/${String(n)}`,
          title: `Issue number ${String(n)}`,
          parent: {
            owner: "acme",
            repo: "widgets",
            number: 9,
            title: "Epic",
            state: "OPEN",
          },
          blockedBy: {
            open: 1,
            notAccessible: 0,
            items: [relation(3, { title: "Issue number 3" })],
          },
        }),
      );
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderAt(initial: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter({ queryClient, history });
  render(<App queryClient={queryClient} router={router} />);
  return { history };
}

const panel = () => document.querySelector("[data-detail-panel]");
const row = (title: string) =>
  within(document.querySelector("tbody") as HTMLElement)
    .getByText(title)
    .closest("tr") as HTMLElement;

describe("the detail panel over the list", () => {
  it("opens from a row click as a non-modal Drawer and keeps the list", async () => {
    stubServer();
    renderAt("/");

    fireEvent.click(await screen.findByText("Issue number 1"));

    expect(await screen.findByText("Body of issue 1")).toBeTruthy();
    expect(panel()).not.toBeNull();
    const labelledBy = panel()?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toBe(
      "acme/widgets#1",
    );
    // Non-modal: nothing behind it is hidden from the accessibility tree.
    expect(row("Issue number 2").closest("[aria-hidden]")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("does not open for a click on a control inside the row", async () => {
    stubServer();
    renderAt("/");
    await screen.findByText("Issue number 1");

    fireEvent.click(
      within(row("Issue number 1")).getByRole("link", {
        name: "Open acme/widgets#1 on GitHub",
      }),
    );
    fireEvent.click(
      within(row("Issue number 1")).getByRole("button", {
        name: "acme/widgets",
      }),
    );

    expect(panel()).toBeNull();
  });

  it("opens the selected row on Enter, follows j and k, and closes on Esc", async () => {
    stubServer();
    renderAt("/");
    await screen.findByText("Issue number 1");

    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(panel()).toBeNull();

    fireEvent.keyDown(document.body, { key: "j" });
    expect(panel()).toBeNull();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(await screen.findByText("Body of issue 1")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "j" });
    expect(await screen.findByText("Body of issue 2")).toBeTruthy();
    expect(row("Issue number 2").getAttribute("aria-current")).toBe("true");
    fireEvent.keyDown(document.body, { key: "k" });
    expect(await screen.findByText("Body of issue 1")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(panel()).toBeNull();
    });
  });

  it("opens a synced dependency in the same panel", async () => {
    stubServer();
    renderAt("/");

    fireEvent.click(await screen.findByText("Issue number 1"));
    const list = await screen.findByRole("list", { name: "Blocked by" });
    fireEvent.click(within(list).getByRole("link", { name: "acme/widgets#3" }));

    expect(await screen.findByText("Body of issue 3")).toBeTruthy();
    expect(screen.queryByText("Body of issue 1")).toBeNull();
  });
});

const header = () =>
  panel()?.querySelector("[data-slot=drawer-header]") as HTMLElement;
const expandToggle = () =>
  within(header()).getByRole("button", { name: "Full screen" });

async function openPanel() {
  stubServer();
  renderAt("/");
  fireEvent.click(await screen.findByText("Issue number 1"));
  await screen.findByText("Body of issue 1");
}

function hover(element: HTMLElement) {
  fireEvent.pointerEnter(element);
  fireEvent.mouseEnter(element);
  fireEvent.pointerMove(element);
  fireEvent.mouseMove(element);
}

describe("the detail panel header", () => {
  it("holds the ref, parent, Open on GitHub, the toggle and Close in one row", async () => {
    await openPanel();

    const row = header();
    expect(row.textContent).toContain("acme/widgets#1");
    expect(
      within(row)
        .getByRole("link", { name: "acme/widgets#9" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/9");
    expect(row.textContent).toContain("Sub-issue of");
    expect(
      within(row)
        .getByRole("link", { name: "Open on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/1");
    expect(within(row).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(expandToggle().getAttribute("aria-pressed")).toBe("false");
    expect(row.querySelector("[data-slot=drawer-title]")?.textContent).toBe(
      "acme/widgets#1",
    );
  });

  it("has a single Close button, in the header and not overlaid on the panel", async () => {
    await openPanel();

    const closes = within(panel() as HTMLElement).getAllByRole("button", {
      name: "Close",
    });
    expect(closes).toHaveLength(1);
    expect(header().contains(closes[0] as HTMLElement)).toBe(true);
    expect(closes[0]?.className.split(" ")).not.toContain("absolute");
  });

  it("keeps the header outside the scrolling panel", async () => {
    await openPanel();

    expect(header().closest("[data-slot=drawer-panel]")).toBeNull();
    expect(
      (panel() as HTMLElement).querySelector("[data-slot=drawer-panel]"),
    ).not.toBeNull();
  });

  it("closes the panel from the Close button", async () => {
    await openPanel();

    fireEvent.click(within(header()).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(panel()).toBeNull();
    });
  });

  it("names the toggle in a tooltip for each state", async () => {
    await openPanel();
    const tooltip = () =>
      document.querySelector("[data-slot=tooltip-popup]")?.textContent;

    hover(expandToggle());
    await waitFor(() => expect(tooltip()).toBe("Full screen"), {
      timeout: 3000,
    });

    fireEvent.click(expandToggle());
    await waitFor(() => expect(tooltip()).toBeUndefined());
    hover(expandToggle());
    await waitFor(() => expect(tooltip()).toBe("Exit full screen"), {
      timeout: 3000,
    });
  });
});

describe("the full-screen detail panel", () => {
  const popupClass = () => (panel() as HTMLElement).className;
  const rail = () =>
    within(panel() as HTMLElement).getByRole("complementary", {
      name: "Properties",
    });

  it("starts as a side panel with the fields above the sections", async () => {
    await openPanel();

    expect(popupClass()).toContain("max-w-2xl");
    expect(popupClass()).not.toContain("max-w-none");
    expect(rail().className).not.toContain("lg:col-start-2");
  });

  it("widens to the viewport with a properties rail, and back", async () => {
    await openPanel();

    fireEvent.click(expandToggle());

    expect(expandToggle().getAttribute("aria-pressed")).toBe("true");
    expect(popupClass()).toContain("max-w-none");
    expect(popupClass()).not.toContain("max-w-2xl");
    expect(rail().className).toContain("lg:col-start-2");
    expect(within(rail()).getByText("Repository")).toBeTruthy();
    expect(window.localStorage.getItem("crossboard:detail:expanded")).toBe(
      "true",
    );

    fireEvent.click(expandToggle());

    expect(expandToggle().getAttribute("aria-pressed")).toBe("false");
    expect(popupClass()).toContain("max-w-2xl");
    expect(rail().className).not.toContain("lg:col-start-2");
    expect(window.localStorage.getItem("crossboard:detail:expanded")).toBe(
      "false",
    );
  });

  it("reopens full screen after a reload", async () => {
    window.localStorage.setItem("crossboard:detail:expanded", "true");
    await openPanel();

    expect(expandToggle().getAttribute("aria-pressed")).toBe("true");
    expect(popupClass()).toContain("max-w-none");
  });

  it("falls back to the side panel when storage throws, and still toggles", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await openPanel();

    expect(expandToggle().getAttribute("aria-pressed")).toBe("false");
    expect(popupClass()).toContain("max-w-2xl");
    fireEvent.click(expandToggle());
    expect(expandToggle().getAttribute("aria-pressed")).toBe("true");
    expect(popupClass()).toContain("max-w-none");
  });

  it("keeps j and k on the list and Esc closing the panel", async () => {
    window.localStorage.setItem("crossboard:detail:expanded", "true");
    await openPanel();

    fireEvent.keyDown(document.body, { key: "j" });
    expect(await screen.findByText("Body of issue 2")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "k" });
    expect(await screen.findByText("Body of issue 1")).toBeTruthy();
    expect(popupClass()).toContain("max-w-none");

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => {
      expect(panel()).toBeNull();
    });
  });

  it("shows the loading state in full screen", async () => {
    window.localStorage.setItem("crossboard:detail:expanded", "true");
    const stub = stubServer();
    stub.mockImplementation(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      const { pathname } = new URL(raw, window.location.origin);
      if (pathname === "/api/me") {
        return Response.json({
          user: { login: "octocat", name: null, avatarUrl: "" },
          installations: [],
          installUrl: "https://github.com/apps/crossboard/installations/new",
        });
      }
      if (pathname === "/api/issues") {
        return Response.json({ items: [item(1)], total: 1, warnings: [] });
      }
      return new Promise<Response>(() => undefined);
    });
    renderAt("/");

    fireEvent.click(await screen.findByText("Issue number 1"));

    expect(
      await screen.findByRole("status", { name: "Loading issue" }),
    ).toBeTruthy();
    expect(popupClass()).toContain("max-w-none");
    expect(
      within(header()).getByRole("button", { name: "Close" }),
    ).toBeTruthy();
  });
});

describe("the route /i/:owner/:repo/:number", () => {
  it("shows the same detail full-page, with no Drawer", async () => {
    stubServer();
    renderAt("/i/acme/widgets/2");

    expect(
      await screen.findByRole("heading", { name: "Issue number 2" }),
    ).toBeTruthy();
    expect(await screen.findByText("Body of issue 2")).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("uses the two-column layout and a header with Open on GitHub", async () => {
    stubServer();
    renderAt("/i/acme/widgets/2");

    const rail = await screen.findByRole("complementary", {
      name: "Properties",
    });
    expect(rail.className).toContain("lg:col-start-2");
    expect(
      screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/2");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("opens a synced dependency as its own route", async () => {
    stubServer();
    const { history } = renderAt("/i/acme/widgets/2");

    const list = await screen.findByRole("list", { name: "Blocked by" });
    fireEvent.click(within(list).getByRole("link", { name: "acme/widgets#3" }));

    await waitFor(() => {
      expect(history.location.pathname).toBe("/i/acme/widgets/3");
    });
    expect(await screen.findByText("Body of issue 3")).toBeTruthy();
  });

  it("rejects an address that is not an issue number", async () => {
    stubServer();
    renderAt("/i/acme/widgets/abc");

    expect(await screen.findByText("Not an issue")).toBeTruthy();
  });
});
