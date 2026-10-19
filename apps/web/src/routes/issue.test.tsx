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
          title: `Issue number ${String(n)}`,
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
    expect(panel()?.getAttribute("aria-label")).toBe("Issue detail");
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
