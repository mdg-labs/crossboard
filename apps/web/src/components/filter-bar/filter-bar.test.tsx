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

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    createdAt: 1,
    updatedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

function stubIssues(answer: (q: string) => IssueItem[]) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.pathname === "/api/issues") {
      const items = answer(url.searchParams.get("q") ?? "");
      return Response.json({ items, total: items.length, warnings: [] });
    }
    if (url.pathname === "/api/me") {
      return Response.json({
        user: { login: "octocat", name: null, avatarUrl: "" },
        installations: [],
        installUrl: "https://github.com/apps/crossboard/installations/new",
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const requestedQueries = (mock: ReturnType<typeof stubIssues>): string[] =>
  mock.mock.calls
    .map(([input]) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      return new URL(raw, window.location.origin);
    })
    .filter((url) => url.pathname === "/api/issues")
    .map((url) => url.searchParams.get("q") ?? "");

function renderApp(initial = "/") {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter({ queryClient, history });
  render(<App queryClient={queryClient} router={router} />);
  return history;
}

const filterInput = () =>
  screen.getByRole("textbox", { name: "Filter issues" }) as HTMLInputElement;

function type(text: string) {
  fireEvent.change(filterInput(), { target: { value: text } });
}

const submit = () => fireEvent.submit(filterInput());

const selectedRows = () =>
  document.querySelectorAll<HTMLElement>("tr[aria-current=true]");

describe("the filter input", () => {
  it("underlines the error range and keeps the last valid results", async () => {
    const mock = stubIssues(() => [issue(1)]);
    const history = renderApp("/?q=is%3Aopen");
    await screen.findByText("Issue number 1");

    type("is:open AND");

    const range = document.querySelector("[data-error-range]");
    expect(range?.textContent).toBe("AND");
    expect(filterInput().getAttribute("aria-invalid")).toBe("true");
    expect(
      within(screen.getByRole("alert")).getByText(
        "AND must be between two terms",
      ),
    ).toBeTruthy();

    submit();
    expect(history.location.search).toBe("?q=is%3Aopen");
    expect(requestedQueries(mock)).toEqual(["is:open"]);
    expect(screen.getByText("Issue number 1")).toBeTruthy();
    expect(screen.queryByRole("alert", { name: /Could not load/ })).toBeNull();
  });

  it("underlines an unbalanced quote through its end", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    type('label:"bug');

    expect(document.querySelector("[data-error-range]")?.textContent).toBe(
      '"bug',
    );
  });

  it("shows no underline for a valid filter", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    type('label:"bug" assignee:ada');

    expect(document.querySelector("[data-error-range]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(filterInput().getAttribute("aria-invalid")).toBeNull();
  });

  it("shows a warning without blocking the filter", async () => {
    const mock = stubIssues(() => [issue(1)]);
    const history = renderApp();
    await screen.findByText("Issue number 1");

    type("foo:bar");

    const warning = screen.getByText(/Unknown qualifier "foo"/);
    expect(warning.closest("[role=status]")).toBeTruthy();
    expect(document.querySelector("[data-error-range]")).toBeNull();

    submit();
    await waitFor(() => expect(history.location.search).toBe("?q=foo%3Abar"));
    await waitFor(() => expect(requestedQueries(mock)).toContain("foo:bar"));
  });

  it("submits the filter into ?q= and reloads the list", async () => {
    const mock = stubIssues((q) =>
      q === "" ? [issue(1), issue(2)] : [issue(2)],
    );
    const history = renderApp();
    await screen.findByText("Issue number 1");

    type("  label:bug  ");
    submit();

    await waitFor(() => expect(history.location.search).toBe("?q=label%3Abug"));
    await waitFor(() =>
      expect(screen.queryByText("Issue number 1")).toBeNull(),
    );
    expect(screen.getByText("Issue number 2")).toBeTruthy();
    expect(requestedQueries(mock)).toEqual(["", "label:bug"]);
  });

  it("reloads the list when the same filter is submitted again", async () => {
    const mock = stubIssues(() => [issue(1)]);
    renderApp("/?q=is%3Aopen");
    await screen.findByText("Issue number 1");

    submit();

    await waitFor(() => expect(requestedQueries(mock)).toHaveLength(2));
  });

  it("shows the filter of the URL and follows it", async () => {
    stubIssues(() => [issue(1)]);
    const history = renderApp("/?q=assignee%3Aada");
    await screen.findByRole("textbox", { name: "Filter issues" });
    expect(filterInput().value).toBe("assignee:ada");
    await screen.findByText("Issue number 1");

    await history.push("/?q=label%3Abug");

    await waitFor(() => expect(filterInput().value).toBe("label:bug"));
  });

  it("keeps the arrow keys, Home and End for the caret", async () => {
    stubIssues(() => [issue(1), issue(2)]);
    renderApp();
    await screen.findByText("Issue number 1");
    type("label:bug");
    filterInput().focus();
    filterInput().setSelectionRange(3, 3);

    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(fireEvent.keyDown(filterInput(), { key }), key).toBe(true);
    }
    expect(document.activeElement).toBe(filterInput());
    expect(filterInput().value).toBe("label:bug");
  });
});

describe("clicks that add to the filter", () => {
  const rich = (n: number) =>
    issue(n, {
      labels: [
        { name: "good first issue", color: "7057ff" },
        { name: 'say "hi"', color: "d73a4a" },
      ],
      assignees: [{ login: "ada", avatarUrl: "https://example.com/ada.png" }],
    });

  it("appends the label, assignee and repo qualifiers", async () => {
    const mock = stubIssues(() => [rich(1)]);
    const history = renderApp("/?q=is%3Aopen");
    await screen.findByText("Issue number 1");

    fireEvent.click(screen.getByRole("button", { name: "good first issue" }));
    await waitFor(() =>
      expect(requestedQueries(mock)).toContain(
        'is:open label:"good first issue"',
      ),
    );

    fireEvent.click(await screen.findByTitle("Filter by assignee ada"));
    await waitFor(() =>
      expect(requestedQueries(mock)).toContain(
        'is:open label:"good first issue" assignee:ada',
      ),
    );

    fireEvent.click(await screen.findByTitle("Filter by acme/widgets"));
    await waitFor(() =>
      expect(requestedQueries(mock)).toContain(
        'is:open label:"good first issue" assignee:ada repo:acme/widgets',
      ),
    );
    expect(filterInput().value).toBe(
      'is:open label:"good first issue" assignee:ada repo:acme/widgets',
    );
    expect(history.location.search).toContain("repo");
  });

  it("starts the filter with the qualifier when there is none", async () => {
    const mock = stubIssues(() => [rich(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    fireEvent.click(await screen.findByTitle("Filter by assignee ada"));

    await waitFor(() =>
      expect(requestedQueries(mock)).toContain("assignee:ada"),
    );
  });

  it("narrows the whole filter when it has a top-level OR", async () => {
    const mock = stubIssues(() => [rich(1)]);
    renderApp("/?q=label%3Aa%20OR%20label%3Ab");
    await screen.findByText("Issue number 1");

    fireEvent.click(screen.getByRole("button", { name: "good first issue" }));

    await waitFor(() =>
      expect(requestedQueries(mock)).toContain(
        '(label:a OR label:b) label:"good first issue"',
      ),
    );
  });

  it("does nothing when wrapping would need too many parentheses", async () => {
    const q = "(((((label:a OR label:b))))) OR label:c";
    const mock = stubIssues(() => [rich(1)]);
    const history = renderApp(`/?q=${encodeURIComponent(q)}`);
    await screen.findByText("Issue number 1");

    fireEvent.click(screen.getByRole("button", { name: "good first issue" }));
    fireEvent.click(await screen.findByTitle("Filter by assignee ada"));

    expect(history.location.search).toBe(`?q=${encodeURIComponent(q)}`);
    expect(requestedQueries(mock)).toEqual([q]);
  });

  it("does nothing for a label whose name contains a double quote", async () => {
    const mock = stubIssues(() => [rich(1)]);
    const history = renderApp("/?q=is%3Aopen");
    await screen.findByText("Issue number 1");

    fireEvent.click(screen.getByText('say "hi"'));

    expect(screen.queryByRole("button", { name: 'say "hi"' })).toBeNull();
    expect(history.location.search).toBe("?q=is%3Aopen");
    expect(requestedQueries(mock)).toEqual(["is:open"]);
  });
});

describe("keyboard shortcuts", () => {
  it("focuses the filter with /", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");
    expect(document.activeElement).not.toBe(filterInput());

    const notPrevented = fireEvent.keyDown(document.body, { key: "/" });

    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(filterInput());
  });

  it("lets a / be typed into the filter", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");
    filterInput().focus();

    expect(fireEvent.keyDown(filterInput(), { key: "/" })).toBe(true);
  });

  it("moves the selection with j and k and keeps it in the list", async () => {
    stubIssues(() => [issue(1), issue(2), issue(3)]);
    renderApp();
    await screen.findByText("Issue number 1");
    expect(selectedRows()).toHaveLength(0);

    fireEvent.keyDown(document.body, { key: "j" });
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-1");
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-3");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-3");
    fireEvent.keyDown(document.body, { key: "k" });
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-2");
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "k" });
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-1");
    expect(selectedRows()).toHaveLength(1);
  });

  it("opens the selected issue on GitHub with o", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    stubIssues(() => [issue(1), issue(2)]);
    renderApp();
    await screen.findByText("Issue number 1");

    fireEvent.keyDown(document.body, { key: "o" });
    expect(open).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "o" });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/widgets/issues/2",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("leaves j, k and o to the filter while typing in it", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    stubIssues(() => [issue(1), issue(2)]);
    renderApp();
    await screen.findByText("Issue number 1");
    fireEvent.keyDown(document.body, { key: "j" });
    filterInput().focus();

    for (const key of ["j", "k", "o"]) {
      expect(fireEvent.keyDown(filterInput(), { key }), key).toBe(true);
    }

    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-1");
    expect(open).not.toHaveBeenCalled();
  });

  it("ignores shortcuts combined with a modifier key", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "j", metaKey: true });

    expect(selectedRows()).toHaveLength(0);
  });

  it("hints the shortcuts with keycaps", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    const keys = [...document.querySelectorAll("kbd[data-slot=kbd]")].map(
      (kbd) => kbd.textContent,
    );
    expect(keys).toEqual(expect.arrayContaining(["/", "j", "k", "o"]));
  });
});
