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
import type { BoardCard, BoardCards } from "@/lib/board-cards";
import type { Board } from "@/lib/boards";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Date.now();

const board = (overrides: Partial<Board> = {}): Board => ({
  id: 7,
  name: "Sprint",
  baseFilter: "",
  sort: "updated-desc",
  subIssueMode: "collapsed",
  showOther: true,
  columns: [
    { id: 70, name: "To do", filter: "label:todo" },
    { id: 71, name: "Doing", filter: "label:doing" },
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function card(n: number, overrides: Partial<BoardCard> = {}): BoardCard {
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
    ...overrides,
  };
}

const cardsOf = (...columns: BoardCard[][]): BoardCards => ({
  columns: columns.map((cards, index) => ({
    id: 70 + index,
    name: ["To do", "Doing"][index] ?? `Column ${String(index)}`,
    count: cards.length,
    cards,
  })),
  warnings: [],
});

interface Stub {
  cards?: (q: string) => Response | Promise<Response>;
  board?: Response;
  suggest?: (prefix: string) => string[];
}

function stubServer({
  cards = () => Response.json(cardsOf([card(1)], [])),
  board: boardAnswer,
  suggest = () => ["acme/rocket", "acme/widgets"],
}: Stub = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(raw, window.location.origin);
    const { pathname } = url;
    if (pathname === "/api/me") {
      return Response.json({
        user: { login: "octocat", name: null, avatarUrl: "" },
        installations: [],
        installUrl: "https://github.com/apps/crossboard/installations/new",
      });
    }
    if (pathname === "/api/boards") {
      return Response.json({ items: [board()] });
    }
    if (pathname === "/api/boards/7") {
      return boardAnswer ?? Response.json(board());
    }
    if (pathname === "/api/boards/7/cards") {
      return cards(url.searchParams.get("q") ?? "");
    }
    if (pathname === "/api/suggest") {
      return Response.json({
        values: suggest(url.searchParams.get("prefix") ?? ""),
      });
    }
    const issue = /^\/api\/issues\/acme\/widgets\/(\d+)(\/details)?$/.exec(
      pathname,
    );
    if (issue !== null) {
      const n = Number(issue[1]);
      return Response.json(
        issue[2] === undefined
          ? summary({
              id: `issue-${String(n)}`,
              number: n,
              title: `Issue number ${String(n)}`,
            })
          : details({ bodyHtml: `<p>Body of issue ${String(n)}</p>` }),
      );
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const requestedCards = (mock: ReturnType<typeof stubServer>): string[] =>
  mock.mock.calls
    .map(([input]) => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      return new URL(raw, window.location.origin);
    })
    .filter((url) => url.pathname === "/api/boards/7/cards")
    .map((url) => url.searchParams.get("q") ?? "");

function renderAt(initial: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter({ queryClient, history });
  render(<App queryClient={queryClient} router={router} />);
  return history;
}

/** Typed text, as Base UI tells it from autofill by the event's `inputType`. */
const typeInto = (input: HTMLInputElement, value: string) =>
  fireEvent.input(input, { target: { value }, inputType: "insertText" });

const column = (name: string) => screen.getByRole("region", { name });

describe("the board route", () => {
  it("shows the columns in order with their counts, then Other", async () => {
    stubServer({
      cards: () =>
        Response.json({
          ...cardsOf([card(1), card(2)], [card(3)]),
          other: { count: 1, cards: [card(4)] },
        }),
    });
    renderAt("/b/7");

    await screen.findByText("Issue number 1");

    const names = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(["To do", "Doing", "Other"]);
    expect(within(column("To do")).getByLabelText("2 cards")).toBeTruthy();
    expect(within(column("To do")).getByText("Issue number 2")).toBeTruthy();
    expect(within(column("Doing")).getByText("Issue number 3")).toBeTruthy();
    expect(within(column("Other")).getByText("Issue number 4")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sprint" })).toBeTruthy();
  });

  it("shows no Other column when the board has none", async () => {
    stubServer();
    renderAt("/b/7");
    await screen.findByText("Issue number 1");
    expect(screen.queryByRole("region", { name: "Other" })).toBeNull();
  });

  it("shows what a card knows and opens it on a click", async () => {
    stubServer({
      cards: () =>
        Response.json(
          cardsOf(
            [
              card(1, {
                title: "Gauge reads empty",
                type: { name: "Bug", color: "RED" },
                labels: [{ name: "urgent", color: "d73a4a" }],
                assignees: [{ login: "ada", avatarUrl: "" }],
                isBlocked: true,
                subIssues: { total: 4, completed: 1 },
              }),
            ],
            [],
          ),
        ),
    });
    renderAt("/b/7");

    const title = await screen.findByText("Gauge reads empty");
    const element = title.closest("[data-issue-id]") as HTMLElement;
    const inside = within(element);
    expect(inside.getByText("acme/widgets")).toBeTruthy();
    expect(inside.getByText("#1")).toBeTruthy();
    expect(inside.getByText("Bug")).toBeTruthy();
    expect(inside.getByText("urgent")).toBeTruthy();
    expect(inside.getByText("blocked")).toBeTruthy();
    expect(inside.getByText("1/4")).toBeTruthy();
    expect(inside.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "1",
    );
    expect(
      inside
        .getByRole("link", { name: "Open acme/widgets#1 on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/1");

    expect(document.querySelector("[data-detail-panel]")).toBeNull();
    fireEvent.click(title);
    await waitFor(() =>
      expect(document.querySelector("[data-detail-panel]")).toBeTruthy(),
    );
    expect(
      await within(
        document.querySelector("[data-detail-panel]") as HTMLElement,
      ).findByRole("heading", { name: "Issue number 1" }),
    ).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelector("[data-detail-panel]")).toBeNull(),
    );
  });
});

describe("nested sub-issues", () => {
  const parent = (): BoardCard =>
    card(1, {
      title: "Parent",
      subIssues: { total: 3, completed: 1 },
      children: [
        card(2, {
          title: "Child",
          columnName: "Doing",
          subIssues: { total: 1, completed: 0 },
          children: [card(3, { title: "Grandchild", columnName: "Doing" })],
        }),
      ],
    });

  const toggleOf = (title: string) =>
    within(
      screen.getByText(title).closest("[data-issue-id]") as HTMLElement,
    ).getByRole("button", { name: /Sub-issues/ });

  it("keeps nested cards behind a toggle that shows the progress", async () => {
    stubServer({ cards: () => Response.json(cardsOf([parent()], [])) });
    renderAt("/b/7");

    await screen.findByText("Parent");
    expect(toggleOf("Parent").textContent).toContain("1/3");
    expect(toggleOf("Parent").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Child")).toBeNull();

    fireEvent.click(toggleOf("Parent"));
    const child = await screen.findByText("Child");
    expect(
      within(child.closest("[data-issue-id]") as HTMLElement).getByText(
        "Doing",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Grandchild")).toBeNull();

    fireEvent.click(toggleOf("Child"));
    expect(await screen.findByText("Grandchild")).toBeTruthy();
  });

  it("does not open the detail when the toggle is clicked", async () => {
    stubServer({ cards: () => Response.json(cardsOf([parent()], [])) });
    renderAt("/b/7");
    await screen.findByText("Parent");

    fireEvent.click(toggleOf("Parent"));

    await screen.findByText("Child");
    expect(document.querySelector("[data-detail-panel]")).toBeNull();
  });

  it("remembers the expanded cards in localStorage per board", async () => {
    stubServer({ cards: () => Response.json(cardsOf([parent()], [])) });
    renderAt("/b/7");
    await screen.findByText("Parent");

    fireEvent.click(toggleOf("Parent"));
    await screen.findByText("Child");

    expect(
      JSON.parse(
        window.localStorage.getItem("crossboard:board:7:expanded") ?? "null",
      ),
    ).toEqual(["issue-1"]);

    cleanup();
    renderAt("/b/7");
    expect(await screen.findByText("Child")).toBeTruthy();
    expect(toggleOf("Parent").getAttribute("aria-expanded")).toBe("true");
  });

  it("starts collapsed and still toggles when storage is unavailable", async () => {
    window.localStorage.setItem(
      "crossboard:board:7:expanded",
      JSON.stringify(["issue-1"]),
    );
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage is blocked");
    });
    stubServer({ cards: () => Response.json(cardsOf([parent()], [])) });
    renderAt("/b/7");

    await screen.findByText("Parent");
    expect(screen.queryByText("Child")).toBeNull();

    fireEvent.click(toggleOf("Parent"));
    expect(await screen.findByText("Child")).toBeTruthy();
  });

  it("starts collapsed when storage holds something else", async () => {
    window.localStorage.setItem("crossboard:board:7:expanded", "{not json");
    stubServer({ cards: () => Response.json(cardsOf([parent()], [])) });
    renderAt("/b/7");

    await screen.findByText("Parent");
    expect(screen.queryByText("Child")).toBeNull();
  });
});

describe("a long column", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => card(index + 1));

  it("renders 200 cards and reveals the rest with Show N more", async () => {
    stubServer({ cards: () => Response.json(cardsOf(many(205), [])) });
    renderAt("/b/7");

    await screen.findByText("Issue number 1");
    const to = within(column("To do"));
    expect(to.getByLabelText("205 cards")).toBeTruthy();
    expect(column("To do").querySelectorAll("[data-issue-id]")).toHaveLength(
      200,
    );
    expect(to.queryByText("Issue number 201")).toBeNull();

    fireEvent.click(to.getByRole("button", { name: "Show 5 more" }));

    expect(column("To do").querySelectorAll("[data-issue-id]")).toHaveLength(
      205,
    );
    expect(to.getByText("Issue number 205")).toBeTruthy();
    expect(to.queryByRole("button", { name: /Show/ })).toBeNull();
  });

  it("shows no button for exactly 200 cards", async () => {
    stubServer({ cards: () => Response.json(cardsOf(many(200), [])) });
    renderAt("/b/7");

    await screen.findByText("Issue number 200");
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });
});

describe("the ad-hoc filter", () => {
  it("narrows the board through ?q= and keeps the board", async () => {
    const mock = stubServer({
      cards: (q) =>
        Response.json(
          q === "" ? cardsOf([card(1), card(2)], []) : cardsOf([card(2)], []),
        ),
    });
    const history = renderAt("/b/7");
    await screen.findByText("Issue number 1");

    const filter = screen.getByRole("combobox", { name: "Filter issues" });
    fireEvent.change(filter, { target: { value: "label:bug" } });
    fireEvent.submit(filter);

    await waitFor(() =>
      expect(screen.queryByText("Issue number 1")).toBeNull(),
    );
    expect(history.location.pathname).toBe("/b/7");
    expect(history.location.search).toBe("?q=label%3Abug");
    expect(requestedCards(mock)).toEqual(["", "label:bug"]);
    expect(screen.getByRole("heading", { name: "Sprint" })).toBeTruthy();
  });

  it("shows the ?q= of the URL in the filter", async () => {
    const mock = stubServer();
    renderAt("/b/7?q=label%3Abug");
    await screen.findByText("Issue number 1");

    expect(
      (
        screen.getByRole("combobox", {
          name: "Filter issues",
        }) as HTMLInputElement
      ).value,
    ).toBe("label:bug");
    expect(requestedCards(mock)).toEqual(["label:bug"]);
  });
});

describe("the repo picker", () => {
  const picker = () =>
    screen.getByRole("combobox", { name: "Repositories" }) as HTMLInputElement;

  it("shows the repos of a typed repo: term as picked", async () => {
    stubServer();
    renderAt("/b/7?q=is%3Aopen%20repo%3Aacme%2Fwidgets%2Cacme%2Frocket");
    await screen.findByText("Issue number 1");

    expect(screen.getByLabelText("acme/widgets")).toBeTruthy();
    expect(screen.getByLabelText("acme/rocket")).toBeTruthy();
    expect(picker().placeholder).toBe("");
  });

  it("shows all repositories when nothing is picked", async () => {
    stubServer();
    renderAt("/b/7?q=label%3Abug");
    await screen.findByText("Issue number 1");

    expect(picker().placeholder).toBe("All repositories");
  });

  it("searches through the suggest route and sets the repo: term", async () => {
    const mock = stubServer();
    const history = renderAt("/b/7?q=label%3Abug");
    await screen.findByText("Issue number 1");

    typeInto(picker(), "acme/r");
    const option = await screen.findByRole("option", { name: "acme/rocket" });
    expect(
      mock.mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).includes(
          "field=repo&prefix=acme%2Fr",
        ),
      ),
    ).toBe(true);
    fireEvent.click(option);

    await waitFor(() =>
      expect(history.location.search).toBe(
        "?q=label%3Abug+repo%3Aacme%2Frocket",
      ),
    );
    await waitFor(() =>
      expect(requestedCards(mock)).toContain("label:bug repo:acme/rocket"),
    );
    expect(history.location.pathname).toBe("/b/7");
  });

  it("keeps the picked repos when the search returns others", async () => {
    stubServer({
      suggest: (prefix) => (prefix === "" ? ["acme/widgets"] : ["acme/rocket"]),
    });
    renderAt("/b/7?q=repo%3Aacme%2Fwidgets");
    await screen.findByText("Issue number 1");

    typeInto(picker(), "r");
    await screen.findByRole("option", { name: "acme/rocket" });

    expect(screen.getByRole("option", { name: "acme/widgets" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "acme/rocket" })).toBeTruthy();
  });

  it("removes the term when the last repo is unpicked", async () => {
    stubServer();
    const history = renderAt("/b/7?q=label%3Abug%20repo%3Aacme%2Fwidgets");
    await screen.findByText("Issue number 1");

    fireEvent.click(
      within(screen.getByLabelText("acme/widgets")).getByRole("button", {
        name: "Remove",
      }),
    );

    await waitFor(() => expect(history.location.search).toBe("?q=label%3Abug"));
  });

  it("is disabled while the filter of the URL does not parse", async () => {
    stubServer({
      cards: () =>
        Response.json(
          {
            error: {
              code: "invalid_query",
              message: "AND must be between two terms",
            },
          },
          { status: 400 },
        ),
    });
    renderAt("/b/7?q=label%3Abug%20AND");

    await screen.findByText("AND must be between two terms");
    expect(picker().disabled).toBe(true);
  });
});

describe("the states of the board", () => {
  it("shows a loading state", async () => {
    stubServer({ cards: () => new Promise<Response>(() => undefined) });
    renderAt("/b/7");

    expect(await screen.findByLabelText("Loading board")).toBeTruthy();
  });

  it("explains an empty board", async () => {
    stubServer({ cards: () => Response.json(cardsOf([], [])) });
    renderAt("/b/7");

    expect(
      await screen.findByText("No open issues match this board"),
    ).toBeTruthy();
  });

  it("shows an error with a way to retry", async () => {
    let healthy = false;
    const mock = stubServer({
      cards: () =>
        healthy
          ? Response.json(cardsOf([card(1)], []))
          : new Response(null, { status: 500 }),
    });
    renderAt("/b/7");

    await screen.findByText("Could not load the board");
    expect(screen.getByText("The server answered 500.")).toBeTruthy();
    expect(screen.queryByText("No open issues match this board")).toBeNull();

    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Issue number 1")).toBeTruthy();
    expect(requestedCards(mock)).toEqual(["", ""]);
  });

  it("says when the board is not found", async () => {
    stubServer({
      board: Response.json(
        { error: { code: "not_found", message: "Board not found" } },
        { status: 404 },
      ),
      cards: () =>
        Response.json(
          { error: { code: "not_found", message: "Board not found" } },
          { status: 404 },
        ),
    });
    renderAt("/b/7");

    expect(await screen.findByText("Board not found")).toBeTruthy();
    expect(screen.queryByLabelText("Loading board")).toBeNull();
  });

  it("says when the id is not a board id", async () => {
    stubServer();
    renderAt("/b/0");

    expect(await screen.findByText("Board not found")).toBeTruthy();
  });
});
