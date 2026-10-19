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
import { createQueryClient } from "@/lib/query-client";
import type { Board } from "@/lib/boards";
import type { SavedView } from "@/lib/views";
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

const view = (id: number, overrides: Partial<SavedView> = {}): SavedView => ({
  id,
  name: `View ${id}`,
  filter: "",
  sort: "updated-desc",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const board = (id: number, overrides: Partial<Board> = {}): Board => ({
  id,
  name: `Board ${id}`,
  baseFilter: "",
  sort: "updated-desc",
  subIssueMode: "collapsed",
  showOther: false,
  columns: [{ id: id * 10, name: "To do", filter: "" }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  contentType: string | null;
}

/** An in-memory `/api/views`, with the calls it saw. */
function stubServer(
  initial: SavedView[] | "error" | "pending",
  answers: {
    boards?: Board[] | "error" | "pending";
    post?: (body: Record<string, unknown>) => Response;
    patch?: (id: number, body: Record<string, unknown>) => Response;
    delete?: (id: number) => Response;
  } = {},
) {
  let store: SavedView[] = Array.isArray(initial) ? [...initial] : [];
  const calls: Call[] = [];
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
        const boards = answers.boards ?? [];
        if (boards === "pending") {
          return new Promise<Response>(() => undefined);
        }
        return boards === "error"
          ? new Response(null, { status: 500 })
          : Response.json({ items: boards });
      }
      const boardMatch = /^\/api\/boards\/(\d+)$/.exec(url.pathname);
      if (boardMatch !== null && method === "GET") {
        const found = (
          Array.isArray(answers.boards) ? answers.boards : []
        ).find((entry) => entry.id === Number(boardMatch[1]));
        return found === undefined
          ? new Response(null, { status: 404 })
          : Response.json(found);
      }
      if (url.pathname === "/api/views" && method === "GET") {
        if (initial === "pending") {
          return new Promise<Response>(() => undefined);
        }
        return initial === "error"
          ? new Response(null, { status: 500 })
          : Response.json({ items: store });
      }
      if (url.pathname === "/api/views" && method === "POST") {
        const custom = answers.post?.(body ?? {});
        if (custom !== undefined) {
          return custom;
        }
        const created = view(store.length + 100, {
          name: String(body?.name),
          filter: String(body?.filter),
          sort: body?.sort as SavedView["sort"],
        });
        store = [...store, created];
        return Response.json(created, { status: 201 });
      }
      const match = /^\/api\/views\/(\d+)$/.exec(url.pathname);
      if (match !== null && method === "PATCH") {
        const id = Number(match[1]);
        const custom = answers.patch?.(id, body ?? {});
        if (custom !== undefined) {
          return custom;
        }
        store = store.map((entry) =>
          entry.id === id ? { ...entry, name: String(body?.name) } : entry,
        );
        return Response.json(store.find((entry) => entry.id === id));
      }
      if (match !== null && method === "DELETE") {
        const id = Number(match[1]);
        const custom = answers.delete?.(id);
        if (custom !== undefined) {
          return custom;
        }
        store = store.filter((entry) => entry.id !== id);
        return new Response(null, { status: 204 });
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

function renderApp(initial = "/") {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createAppRouter({ queryClient, history });
  render(<App queryClient={queryClient} router={router} />);
  return history;
}

/** Looked up with `hidden`: a modal dialog hides the rest of the page from the accessibility tree. */
const trigger = () =>
  screen.getByRole("button", { name: /^View: /, hidden: true });

async function openMenu() {
  fireEvent.click(await screen.findByRole("button", { name: /^View: / }));
  return screen.findByRole("menu");
}

const clickItem = (name: RegExp | string, role = "menuitem") =>
  fireEvent.click(screen.getByRole(role, { name }));

describe("the view switcher menu", () => {
  it("lists the saved views and opens one by setting ?q= and ?sort=", async () => {
    stubServer([
      view(1, { name: "My bugs", filter: "label:bug", sort: "title-asc" }),
      view(2, { name: "Everything" }),
    ]);
    const history = renderApp();
    const menu = await openMenu();

    await within(menu).findByRole("menuitemradio", { name: "My bugs" });
    expect(
      within(menu).getByRole("menuitemradio", { name: "Everything" }),
    ).toBeTruthy();

    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: "My bugs" }),
    );

    await waitFor(() =>
      expect(history.location.search).toBe("?q=label%3Abug&sort=title-asc"),
    );
    await waitFor(() => expect(trigger().textContent).toBe("My bugs"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await openMenu();
    expect(
      screen
        .getByRole("menuitemradio", { name: "My bugs" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("opens a view with the default filter and sort at /", async () => {
    stubServer([view(2, { name: "Everything" })]);
    const history = renderApp("/?q=label%3Abug&sort=repo-asc");
    await openMenu();

    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Everything" }),
    );

    await waitFor(() => expect(history.location.search).toBe(""));
  });

  it("labels the trigger with the open view, All issues, or an unsaved filter", async () => {
    stubServer([view(1, { name: "My bugs", filter: "label:bug" })]);
    renderApp("/?q=label%3Abug");
    await waitFor(() => expect(trigger().textContent).toBe("My bugs"));
    cleanup();

    stubServer([view(1, { name: "My bugs", filter: "label:bug" })]);
    renderApp("/");
    await screen.findByRole("button", { name: "View: All issues" });
    cleanup();

    stubServer([view(1, { name: "My bugs", filter: "label:bug" })]);
    renderApp("/?q=assignee%3Aada");
    await screen.findByRole("button", { name: "View: Unsaved filter" });
  });

  it("loads the views only when the menu is opened or a filter is set", async () => {
    const server = stubServer([view(1, { name: "My bugs" })]);
    renderApp();
    await screen.findByRole("button", { name: "View: All issues" });
    expect(server.calls("GET", "/api/views")).toEqual([]);

    await openMenu();

    await waitFor(() =>
      expect(server.calls("GET", "/api/views")).toHaveLength(1),
    );
  });

  it("shows a loading state while the views load", async () => {
    stubServer("pending");
    renderApp();
    const menu = await openMenu();

    expect(
      within(menu).getByRole("status", { name: "Loading views" }),
    ).toBeTruthy();
  });

  it("shows an empty state when there are no views", async () => {
    stubServer([]);
    renderApp();
    const menu = await openMenu();

    expect(await within(menu).findByText("No saved views yet")).toBeTruthy();
    expect(within(menu).queryByRole("menuitemradio")).toBeNull();
  });

  it("shows an error with a retry when the views cannot be loaded", async () => {
    const server = stubServer("error");
    renderApp();
    const menu = await openMenu();

    expect(
      await within(menu).findByText("Could not load your views."),
    ).toBeTruthy();
    expect(within(menu).queryByText("No saved views yet")).toBeNull();
    const before = server.calls("GET", "/api/views").length;

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Try again" }));

    await waitFor(() =>
      expect(server.calls("GET", "/api/views").length).toBeGreaterThan(before),
    );
  });
});

describe("saving a view", () => {
  it("names the current filter and sort in a dialog and sends them as JSON", async () => {
    const server = stubServer([]);
    renderApp("/?q=label%3Abug&sort=title-asc");
    await openMenu();

    clickItem(/Save current view/);
    const dialog = await screen.findByRole("dialog", { name: "Save view" });
    expect(within(dialog).getByText("label:bug")).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "  Bugs by title  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls("POST", "/api/views")).toEqual([
      expect.objectContaining({
        body: { name: "Bugs by title", filter: "label:bug", sort: "title-asc" },
        contentType: "application/json",
      }),
    ]);
    await waitFor(() => expect(trigger().textContent).toBe("Bugs by title"));
  });

  it("keeps the dialog open and names the problem when the name is taken", async () => {
    stubServer([view(1, { name: "Taken" })], {
      post: () =>
        Response.json(
          { error: { code: "conflict", message: "duplicate" } },
          { status: 409 },
        ),
    });
    renderApp("/?q=label%3Abug");
    await openMenu();
    clickItem(/Save current view/);
    const dialog = await screen.findByRole("dialog", { name: "Save view" });

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "Taken" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));

    expect(
      await within(dialog).findByText(
        "You already have a view with this name.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Save view" })).toBeTruthy();
  });

  it("shows the server's message when saving fails, and does not claim success", async () => {
    stubServer([], {
      post: () =>
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
    renderApp("/?q=is%3Aopen");
    await openMenu();
    clickItem(/Save current view/);
    const dialog = await screen.findByRole("dialog", { name: "Save view" });

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "Broken" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));

    expect(
      await within(dialog).findByText("AND must be between two terms"),
    ).toBeTruthy();
    expect(trigger().textContent).not.toBe("Broken");
  });

  it("does not send a blank name", async () => {
    const server = stubServer([]);
    renderApp();
    await openMenu();
    clickItem(/Save current view/);
    const dialog = await screen.findByRole("dialog", { name: "Save view" });

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "   " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));

    expect(
      await within(dialog).findByText("Enter a name of 1 to 100 characters."),
    ).toBeTruthy();
    expect(server.calls("POST", "/api/views")).toEqual([]);
  });
});

describe("renaming and deleting the open view", () => {
  const mine = view(7, { name: "My bugs", filter: "label:bug" });

  it("offers neither when no view is open", async () => {
    stubServer([mine]);
    renderApp("/");
    await openMenu();

    expect(screen.queryByRole("menuitem", { name: /^Rename/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
  });

  it("renames it in a dialog", async () => {
    const server = stubServer([mine]);
    renderApp("/?q=label%3Abug");
    await waitFor(() => expect(trigger().textContent).toBe("My bugs"));
    await openMenu();

    clickItem(/^Rename/);
    const dialog = await screen.findByRole("dialog", { name: "Rename view" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect((name as HTMLInputElement).value).toBe("My bugs");
    fireEvent.change(name, { target: { value: "Open bugs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls("PATCH", "/api/views/7")).toEqual([
      expect.objectContaining({
        body: { name: "Open bugs" },
        contentType: "application/json",
      }),
    ]);
    await waitFor(() => expect(trigger().textContent).toBe("Open bugs"));
  });

  it("asks before deleting, then deletes it with a JSON content type", async () => {
    const server = stubServer([mine]);
    renderApp("/?q=label%3Abug");
    await waitFor(() => expect(trigger().textContent).toBe("My bugs"));
    await openMenu();

    clickItem(/^Delete/);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete this view?")).toBeTruthy();
    expect(server.calls("DELETE", "/api/views/7")).toEqual([]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete view" }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(server.calls("DELETE", "/api/views/7")).toEqual([
      expect.objectContaining({ contentType: "application/json" }),
    ]);
    await waitFor(() => expect(trigger().textContent).toBe("Unsaved filter"));
  });

  it("keeps the view when the confirmation is cancelled", async () => {
    const server = stubServer([mine]);
    renderApp("/?q=label%3Abug");
    await waitFor(() => expect(trigger().textContent).toBe("My bugs"));
    await openMenu();
    clickItem(/^Delete/);
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(server.calls("DELETE", "/api/views/7")).toEqual([]);
    expect(trigger().textContent).toBe("My bugs");
  });

  it("keeps the dialog open and shows the error when deleting fails", async () => {
    stubServer([mine], {
      delete: () =>
        Response.json(
          { error: { code: "internal_error", message: "Database is locked" } },
          { status: 500 },
        ),
    });
    renderApp("/?q=label%3Abug");
    await waitFor(() => expect(trigger().textContent).toBe("My bugs"));
    await openMenu();
    clickItem(/^Delete/);
    const dialog = await screen.findByRole("alertdialog");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete view" }),
    );

    expect(await within(dialog).findByText("Database is locked")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(trigger().textContent).toBe("My bugs");
  });
});

describe("boards in the switcher", () => {
  it("lists the user's boards next to the saved views", async () => {
    stubServer([view(1, { name: "My bugs" })], {
      boards: [board(3, { name: "Sprint" }), board(4, { name: "Roadmap" })],
    });
    renderApp();
    const menu = await openMenu();

    await within(menu).findByRole("menuitem", { name: "Sprint" });
    expect(
      within(menu).getByRole("menuitem", { name: "Roadmap" }),
    ).toBeTruthy();
    expect(
      await within(menu).findByRole("menuitemradio", { name: "My bugs" }),
    ).toBeTruthy();
  });

  it("opens a board at /b/:id", async () => {
    stubServer([], { boards: [board(3, { name: "Sprint" })] });
    const history = renderApp();
    const menu = await openMenu();

    fireEvent.click(
      await within(menu).findByRole("menuitem", { name: "Sprint" }),
    );

    await waitFor(() => expect(history.location.pathname).toBe("/b/3"));
  });

  it("opens the form for a new board", async () => {
    stubServer([], { boards: [] });
    const history = renderApp();
    await openMenu();

    clickItem(/^New board/);

    await waitFor(() => expect(history.location.pathname).toBe("/b/new"));
  });

  it("names the open board and offers to edit it", async () => {
    stubServer([], { boards: [board(3, { name: "Sprint" })] });
    renderApp("/b/new");
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /^Edit/ })).toBeNull();
    cleanup();

    stubServer([], { boards: [board(3, { name: "Sprint" })] });
    renderApp("/b/3/edit");
    await waitFor(() => expect(trigger().textContent).toBe("Sprint"));
    await openMenu();

    expect(
      await screen.findByRole("menuitem", { name: "Edit “Sprint”…" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: /Save current view/ }),
    ).toBeNull();
  });

  it("shows a loading state while the boards load", async () => {
    stubServer([], { boards: "pending" });
    renderApp();
    const menu = await openMenu();

    expect(
      within(menu).getByRole("status", { name: "Loading boards" }),
    ).toBeTruthy();
  });

  it("shows an error with a retry when the boards cannot be loaded", async () => {
    const server = stubServer([], { boards: "error" });
    renderApp();
    const menu = await openMenu();

    expect(
      await within(menu).findByText("Could not load your boards."),
    ).toBeTruthy();
    const before = server.calls("GET", "/api/boards").length;

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Try again" }));

    await waitFor(() =>
      expect(server.calls("GET", "/api/boards").length).toBeGreaterThan(before),
    );
  });
});
