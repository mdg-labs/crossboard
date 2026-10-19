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

function stubIssues(
  answer: (q: string) => IssueItem[],
  suggest: (field: string, prefix: string) => Response = () =>
    Response.json({ values: [] }),
) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.pathname === "/api/issues") {
      const items = answer(url.searchParams.get("q") ?? "");
      return Response.json({ items, total: items.length, warnings: [] });
    }
    if (url.pathname === "/api/suggest") {
      return suggest(
        url.searchParams.get("field") ?? "",
        url.searchParams.get("prefix") ?? "",
      );
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
  screen.getByRole("combobox", { name: "Filter issues" }) as HTMLInputElement;

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
    await screen.findByRole("combobox", { name: "Filter issues" });
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

    for (const key of ["ArrowLeft", "ArrowRight"]) {
      expect(fireEvent.keyDown(filterInput(), { key }), key).toBe(true);
    }
    // The Autocomplete moves the caret itself on Home and End.
    fireEvent.keyDown(filterInput(), { key: "Home" });
    expect(filterInput().selectionStart).toBe(0);
    fireEvent.keyDown(filterInput(), { key: "End" });
    expect(filterInput().selectionStart).toBe(9);
    expect(document.activeElement).toBe(filterInput());
    expect(filterInput().value).toBe("label:bug");
  });
});

const suggestedValues = (mock: ReturnType<typeof stubIssues>): string[] =>
  mock.mock.calls
    .map(([input]) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      return new URL(raw, window.location.origin);
    })
    .filter((url) => url.pathname === "/api/suggest")
    .map(
      (url) =>
        `${url.searchParams.get("field")}:${url.searchParams.get("prefix")}`,
    );

const options = () =>
  screen.queryAllByRole("option").map((option) => option.textContent);

/** Typing as a keyboard does: the Autocomplete opens only for typed input, not for a bare change. */
function typeAndFocus(text: string) {
  filterInput().focus();
  fireEvent.input(filterInput(), {
    target: { value: text },
    inputType: "insertText",
  });
}

describe("autocomplete", () => {
  it("keeps a submit button in the form so Enter still submits it", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    const form = filterInput().closest("form");
    expect(form?.querySelectorAll("input:not([type=hidden])").length).toBe(2);
    expect(form?.querySelector("button[type=submit]")).toBeTruthy();
  });

  it("suggests qualifier names while typing one, and values after choosing it", async () => {
    const mock = stubIssues(
      () => [issue(1)],
      (field) =>
        Response.json({ values: field === "label" ? ["bug", "docs"] : [] }),
    );
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("is:open la");

    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(options()).toEqual(["label:"]);
    expect(suggestedValues(mock)).toEqual([]);

    fireEvent.click(screen.getByRole("option", { name: "label:" }));

    expect(filterInput().value).toBe("is:open label:");
    await waitFor(() => expect(options()).toEqual(["bug", "docs"]));
    expect(suggestedValues(mock)).toEqual(["label:"]);
  });

  it("suggests values after a colon with the typed text as the prefix", async () => {
    const mock = stubIssues(
      () => [issue(1)],
      (_field, prefix) =>
        Response.json({ values: prefix === "oc" ? ["octocat"] : [] }),
    );
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("assignee:oc");

    await waitFor(() => expect(options()).toEqual(["octocat"]));
    expect(suggestedValues(mock)).toEqual(["assignee:oc"]);
  });

  it("uses the text after the last comma, without quotes, as the prefix", async () => {
    const mock = stubIssues(
      () => [issue(1)],
      () => Response.json({ values: ["good first issue"] }),
    );
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus('label:bug,"good f');

    await waitFor(() => expect(options()).toEqual(["good first issue"]));
    expect(suggestedValues(mock)).toEqual(["label:good f"]);
  });

  it("inserts the chosen value, quoted when it contains a space", async () => {
    stubIssues(
      () => [issue(1)],
      () => Response.json({ values: ["good first issue", "bug"] }),
    );
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("label:bug,go");
    fireEvent.click(
      await screen.findByRole("option", { name: "good first issue" }),
    );

    expect(filterInput().value).toBe('label:bug,"good first issue"');
    expect(document.querySelector("[data-error-range]")).toBeNull();
  });

  it("inserts a value without quotes when it has no space", async () => {
    stubIssues(
      () => [issue(1)],
      () => Response.json({ values: ["octocat"] }),
    );
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("assignee:oc");
    fireEvent.click(await screen.findByRole("option", { name: "octocat" }));

    expect(filterInput().value).toBe("assignee:octocat");
  });

  it("lets the arrow keys and Enter drive the suggestions, not the list or the form", async () => {
    const mock = stubIssues(
      () => [issue(1), issue(2)],
      () => Response.json({ values: ["bug", "docs"] }),
    );
    const history = renderApp();
    await screen.findByText("Issue number 1");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-1");

    typeAndFocus("label:");
    await waitFor(() => expect(options()).toEqual(["bug", "docs"]));
    fireEvent.keyDown(filterInput(), { key: "ArrowDown" });
    fireEvent.keyDown(filterInput(), { key: "ArrowDown" });
    fireEvent.keyDown(filterInput(), { key: "Enter" });

    expect(filterInput().value).toBe("label:docs");
    expect(selectedRows()[0]?.dataset.issueId).toBe("issue-1");
    expect(history.location.search).toBe("");
    expect(requestedQueries(mock)).toEqual([""]);
  });

  it("submits the filter on Enter when no suggestion is highlighted", async () => {
    const mock = stubIssues(
      () => [issue(1)],
      () => Response.json({ values: ["bug"] }),
    );
    const history = renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("label:b");
    await waitFor(() => expect(options()).toEqual(["bug"]));
    fireEvent.keyDown(filterInput(), { key: "Enter" });
    submit();

    await waitFor(() => expect(history.location.search).toBe("?q=label%3Ab"));
    await waitFor(() => expect(requestedQueries(mock)).toContain("label:b"));
  });

  it("keeps what was typed when Escape closes the suggestions", async () => {
    stubIssues(
      () => [issue(1)],
      () => Response.json({ values: ["bug"] }),
    );
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("label:b");
    await waitFor(() => expect(options()).toEqual(["bug"]));
    fireEvent.keyDown(filterInput(), { key: "Escape" });
    await waitFor(() => expect(options()).toEqual([]));
    fireEvent.keyDown(filterInput(), { key: "Escape" });

    expect(filterInput().value).toBe("label:b");
  });

  it("says so when no value matches", async () => {
    stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("label:zzz");

    expect(await screen.findByText("No matching values")).toBeTruthy();
  });

  it("says so when the suggestions cannot be loaded, and keeps the filter usable", async () => {
    stubIssues(
      () => [issue(1)],
      () => new Response(null, { status: 500 }),
    );
    const history = renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("label:b");

    expect(await screen.findByText("Suggestions are unavailable")).toBeTruthy();
    expect(screen.queryByText("No matching values")).toBeNull();
    submit();
    await waitFor(() => expect(history.location.search).toBe("?q=label%3Ab"));
  });

  it("suggests nothing for a qualifier without server values", async () => {
    const mock = stubIssues(() => [issue(1)]);
    renderApp();
    await screen.findByText("Issue number 1");

    typeAndFocus("is:o");

    expect(options()).toEqual([]);
    expect(screen.queryByText("No matching values")).toBeNull();
    expect(suggestedValues(mock)).toEqual([]);
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
