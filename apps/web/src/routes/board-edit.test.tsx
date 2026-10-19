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
import type { Board } from "@/lib/boards";
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

const board = (overrides: Partial<Board> = {}): Board => ({
  id: 7,
  name: "Sprint",
  baseFilter: "repo:acme/widgets",
  sort: "title-asc",
  subIssueMode: "expanded",
  showOther: true,
  columns: [
    { id: 70, name: "To do", filter: 'label:"status: todo"' },
    { id: 71, name: "Doing", filter: 'label:"status: doing"' },
    { id: 72, name: "Done", filter: "is:closed" },
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  contentType: string | null;
}

type Answer = Response | "pending";

/** An in-memory `/api/boards`, with the calls it saw. */
function stubServer(
  options: {
    get?: Answer;
    post?: Answer;
    patch?: Answer;
    delete?: Answer;
    boards?: Board[];
  } = {},
) {
  const boards = options.boards ?? [board()];
  const calls: Call[] = [];
  const answer = (value: Answer | undefined, fallback: () => Response) => {
    if (value === "pending") {
      return new Promise<Response>(() => undefined);
    }
    return value ?? fallback();
  };
  const mock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw =
        typeof input === "string" || input instanceof URL ? input : input.url;
      const url = new URL(raw, window.location.origin);
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({
        method,
        path: url.pathname,
        body,
        contentType: new Headers(init?.headers).get("Content-Type"),
      });
      if (url.pathname === "/api/issues") {
        return Response.json({ items: [], total: 0, warnings: [] });
      }
      if (url.pathname === "/api/me") {
        return Response.json({
          user: { login: "octocat", name: null, avatarUrl: "" },
          installations: [],
          installUrl: "https://github.com/apps/crossboard/installations/new",
        });
      }
      if (url.pathname === "/api/boards" && method === "GET") {
        return Response.json({ items: boards });
      }
      if (url.pathname === "/api/boards" && method === "POST") {
        return answer(options.post, () =>
          Response.json(board({ id: 99, ...body }), { status: 201 }),
        );
      }
      const match = /^\/api\/boards\/(\d+)$/.exec(url.pathname);
      if (match !== null) {
        const found = boards.find((entry) => entry.id === Number(match[1]));
        if (method === "GET") {
          return answer(options.get, () =>
            found === undefined
              ? Response.json(
                  { error: { code: "not_found", message: "Not found" } },
                  { status: 404 },
                )
              : Response.json(found),
          );
        }
        if (method === "PATCH") {
          return answer(options.patch, () =>
            Response.json({ ...found, ...body }),
          );
        }
        if (method === "DELETE") {
          return answer(
            options.delete,
            () => new Response(null, { status: 204 }),
          );
        }
      }
      return new Response(null, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", mock);
  return {
    calls: (method: string, path: string) =>
      calls.filter((call) => call.method === method && call.path === path),
  };
}

function renderApp(initial: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter({ queryClient, history });
  render(<App queryClient={queryClient} router={router} />);
  return history;
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: label }), {
    target: { value },
  });

const field = (label: string) =>
  (screen.getByRole("textbox", { name: label }) as HTMLInputElement).value;

async function chooseOption(trigger: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: trigger }));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

describe("/b/new", () => {
  it("shows an empty form with one empty column and the defaults", async () => {
    stubServer();
    renderApp("/b/new");

    expect(
      await screen.findByRole("heading", { name: "New board" }),
    ).toBeTruthy();
    expect(field("Name")).toBe("");
    expect(field("Base filter")).toBe("");
    expect(field("Column 1 name")).toBe("");
    expect(screen.getByRole("combobox", { name: "Sort" }).textContent).toBe(
      "Recently updated",
    );
    expect(
      screen.getByRole("combobox", { name: "Sub-issues" }).textContent,
    ).toBe("Collapsed");
    expect(
      screen
        .getByRole("switch", { name: /Show an Other column/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByRole("button", { name: "Delete board" })).toBeNull();
  });

  it("creates the board with every field and opens it", async () => {
    const server = stubServer();
    const history = renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });

    type("Name", "  Roadmap ");
    type("Base filter", "repo:acme/widgets");
    await chooseOption("Sort", "Title");
    await chooseOption("Sub-issues", "Expanded");
    fireEvent.click(
      screen.getByRole("switch", { name: /Show an Other column/ }),
    );
    type("Column 1 name", "To do");
    type("Column 1 filter", "label:bug");
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    type("Column 2 name", "Done");
    type("Column 2 filter", "is:closed");
    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    await waitFor(() => expect(history.location.pathname).toBe("/b/99"));
    expect(server.calls("POST", "/api/boards")).toEqual([
      expect.objectContaining({
        contentType: "application/json",
        body: {
          name: "Roadmap",
          baseFilter: "repo:acme/widgets",
          sort: "title-asc",
          subIssueMode: "expanded",
          showOther: true,
          columns: [
            { name: "To do", filter: "label:bug" },
            { name: "Done", filter: "is:closed" },
          ],
        },
      }),
    ]);
  });

  it("blocks saving while a filter does not parse and shows the error at its column", async () => {
    const server = stubServer();
    const history = renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });
    type("Name", "Roadmap");
    type("Column 1 name", "To do");
    type("Column 1 filter", "AND label:bug");

    const filter = screen.getByRole("textbox", { name: "Column 1 filter" });
    await waitFor(() =>
      expect(filter.getAttribute("aria-invalid")).toBe("true"),
    );
    const message = await screen.findByText(/AND/);
    expect(filter.closest("[data-slot=field]")?.contains(message)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    await screen.findByText(/AND/);
    expect(server.calls("POST", "/api/boards")).toEqual([]);
    expect(history.location.pathname).toBe("/b/new");

    type("Column 1 filter", "label:bug");
    await waitFor(() => expect(screen.queryByText(/AND/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(history.location.pathname).toBe("/b/99"));
  });

  it("names the base filter's parse error at its field", async () => {
    const server = stubServer();
    renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });
    type("Name", "Roadmap");
    type("Column 1 name", "To do");
    type("Base filter", "label:");

    const field = screen.getByRole("textbox", { name: "Base filter" });
    await waitFor(() =>
      expect(field.getAttribute("aria-invalid")).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    await waitFor(() =>
      expect(field.getAttribute("aria-invalid")).toBe("true"),
    );
    expect(server.calls("POST", "/api/boards")).toEqual([]);
  });

  it("does not send a blank board or column name", async () => {
    const server = stubServer();
    renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });

    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    expect(
      await screen.findAllByText("Enter a name of 1 to 100 characters."),
    ).toHaveLength(2);
    expect(server.calls("POST", "/api/boards")).toEqual([]);
  });

  it("adds, renames, moves and removes columns", async () => {
    renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });
    type("Column 1 name", "A");
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    type("Column 2 name", "B");
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    type("Column 3 name", "C");

    expect(
      screen
        .getByRole("button", { name: "Move column 1 up" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Move column 3 down" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Move column 3 up" }));
    expect([
      field("Column 1 name"),
      field("Column 2 name"),
      field("Column 3 name"),
    ]).toEqual(["A", "C", "B"]);

    fireEvent.click(screen.getByRole("button", { name: "Move column 1 down" }));
    expect([
      field("Column 1 name"),
      field("Column 2 name"),
      field("Column 3 name"),
    ]).toEqual(["C", "A", "B"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove column 2" }));
    expect([field("Column 1 name"), field("Column 2 name")]).toEqual([
      "C",
      "B",
    ]);
    expect(screen.queryByRole("textbox", { name: "Column 3 name" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove column 2" }));
    expect(
      screen
        .getByRole("button", { name: "Remove column 1" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("stops adding columns at 20", async () => {
    renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });
    for (let count = 1; count < 20; count += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    }

    expect(
      screen.getByRole("textbox", { name: "Column 20 name" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Add column" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the form and shows the server's message when saving fails", async () => {
    stubServer({
      post: Response.json(
        { error: { code: "internal_error", message: "Database is locked" } },
        { status: 500 },
      ),
    });
    const history = renderApp("/b/new");
    await screen.findByRole("heading", { name: "New board" });
    type("Name", "Roadmap");
    type("Column 1 name", "To do");

    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    expect(await screen.findByText("Database is locked")).toBeTruthy();
    expect(history.location.pathname).toBe("/b/new");
    expect(field("Name")).toBe("Roadmap");
  });
});

describe("/b/:boardId/edit", () => {
  it("loads the board into the form", async () => {
    stubServer();
    renderApp("/b/7/edit");

    await waitFor(() => expect(field("Name")).toBe("Sprint"));
    expect(field("Base filter")).toBe("repo:acme/widgets");
    expect(screen.getByRole("combobox", { name: "Sort" }).textContent).toBe(
      "Title",
    );
    expect(
      screen.getByRole("combobox", { name: "Sub-issues" }).textContent,
    ).toBe("Expanded");
    expect(
      screen
        .getByRole("switch", { name: /Show an Other column/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(field("Column 1 name")).toBe("To do");
    expect(field("Column 2 filter")).toBe('label:"status: doing"');
    expect(field("Column 3 name")).toBe("Done");
  });

  it("shows a loading state while the board loads", async () => {
    stubServer({ get: "pending" });
    renderApp("/b/7/edit");

    expect(
      await screen.findByRole("status", { name: "Loading board" }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("shows an error with a retry when the board cannot be loaded", async () => {
    const server = stubServer({ get: new Response(null, { status: 500 }) });
    renderApp("/b/7/edit");

    expect(await screen.findByText("Could not load the board")).toBeTruthy();
    expect(screen.queryByText("Board not found")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    const before = server.calls("GET", "/api/boards/7").length;

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(server.calls("GET", "/api/boards/7").length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("says so when the board does not exist", async () => {
    stubServer();
    renderApp("/b/8/edit");

    expect(await screen.findByText("Board not found")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  it("says so for an id that is not a number, without asking the server", async () => {
    const server = stubServer();
    renderApp("/b/abc/edit");

    expect(await screen.findByText("Board not found")).toBeTruthy();
    expect(server.calls("GET", "/api/boards/abc")).toEqual([]);
  });

  it("saves every field and opens the board", async () => {
    const server = stubServer();
    const history = renderApp("/b/7/edit");
    await waitFor(() => expect(field("Name")).toBe("Sprint"));

    type("Name", "Sprint 2");
    fireEvent.click(
      screen.getByRole("switch", { name: /Show an Other column/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move column 3 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove column 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save board" }));

    await waitFor(() => expect(history.location.pathname).toBe("/b/7"));
    expect(server.calls("PATCH", "/api/boards/7")).toEqual([
      expect.objectContaining({
        contentType: "application/json",
        body: {
          name: "Sprint 2",
          baseFilter: "repo:acme/widgets",
          sort: "title-asc",
          subIssueMode: "expanded",
          showOther: false,
          columns: [
            { name: "Done", filter: "is:closed" },
            { name: "Doing", filter: 'label:"status: doing"' },
          ],
        },
      }),
    ]);
  });

  it("shows the server's message and stays when saving fails", async () => {
    stubServer({
      patch: Response.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    });
    const history = renderApp("/b/7/edit");
    await waitFor(() => expect(field("Name")).toBe("Sprint"));

    fireEvent.click(screen.getByRole("button", { name: "Save board" }));

    expect(await screen.findByText("Not found")).toBeTruthy();
    expect(history.location.pathname).toBe("/b/7/edit");
  });

  it("asks before deleting, then deletes the board and returns to /", async () => {
    const server = stubServer();
    const history = renderApp("/b/7/edit");
    await waitFor(() => expect(field("Name")).toBe("Sprint"));

    fireEvent.click(screen.getByRole("button", { name: "Delete board" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete this board?")).toBeTruthy();
    expect(server.calls("DELETE", "/api/boards/7")).toEqual([]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete board" }),
    );

    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(server.calls("DELETE", "/api/boards/7")).toEqual([
      expect.objectContaining({ contentType: "application/json" }),
    ]);
  });

  it("keeps the board when the confirmation is cancelled", async () => {
    const server = stubServer();
    const history = renderApp("/b/7/edit");
    await waitFor(() => expect(field("Name")).toBe("Sprint"));
    fireEvent.click(screen.getByRole("button", { name: "Delete board" }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(server.calls("DELETE", "/api/boards/7")).toEqual([]);
    expect(history.location.pathname).toBe("/b/7/edit");
  });

  it("keeps the dialog open and shows the error when deleting fails", async () => {
    const history =
      (stubServer({
        delete: Response.json(
          { error: { code: "internal_error", message: "Database is locked" } },
          { status: 500 },
        ),
      }),
      renderApp("/b/7/edit"));
    await waitFor(() => expect(field("Name")).toBe("Sprint"));
    fireEvent.click(screen.getByRole("button", { name: "Delete board" }));
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete board" }),
    );

    expect(await within(dialog).findByText("Database is locked")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(history.location.pathname).toBe("/b/7/edit");
  });
});
