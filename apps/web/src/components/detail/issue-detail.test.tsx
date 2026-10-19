import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDetail } from "@/components/detail/issue-detail";
import { details, relation, summary } from "@/components/detail/test-data";
import { createQueryClient } from "@/lib/query-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Stub {
  summary?: () => Response | Promise<Response>;
  details?: () => Response | Promise<Response>;
}

function stubServer(stub: Stub) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const { pathname } = new URL(raw, window.location.origin);
    if (pathname === "/api/issues/acme/widgets/1" && stub.summary) {
      return stub.summary();
    }
    if (pathname === "/api/issues/acme/widgets/1/details" && stub.details) {
      return stub.details();
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderDetail(onOpenIssue = vi.fn(), wide = false) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <IssueDetail
        issue={{ owner: "acme", repo: "widgets", number: 1 }}
        onOpenIssue={onOpenIssue}
        wide={wide}
      />
    </QueryClientProvider>,
  );
  return onOpenIssue;
}

const errorBody = (message: string, extra: object = {}) => ({
  error: { code: "x", message, ...extra },
});

describe("the issue detail", () => {
  it("shows a Skeleton until the summary arrives", async () => {
    stubServer({
      summary: () => new Promise<Response>(() => undefined),
      details: () => new Promise<Response>(() => undefined),
    });
    renderDetail();

    expect(screen.getByRole("status", { name: "Loading issue" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows the summary at once and a Spinner while the body loads", async () => {
    stubServer({
      summary: () =>
        Response.json(
          summary({
            type: { name: "Bug", color: "RED" },
            milestone: { title: "v1.0", url: "https://github.com/m/1" },
            labels: [{ name: "bug", color: "d73a4a" }],
            assignees: [{ login: "hubot", avatarUrl: "" }],
            parent: {
              owner: "acme",
              repo: "widgets",
              number: 9,
              title: "Epic",
              state: "OPEN",
            },
          }),
        ),
      details: () => new Promise<Response>(() => undefined),
    });
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Widget fails to render" }),
    ).toBeTruthy();
    expect(screen.getByText("acme/widgets#1")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Bug")).toBeTruthy();
    expect(screen.getByText("v1.0").closest("a")?.getAttribute("href")).toBe(
      "https://github.com/m/1",
    );
    expect(screen.getByText("bug").closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/labels/bug",
    );
    expect(screen.getByText("hubot").closest("a")?.getAttribute("href")).toBe(
      "https://github.com/hubot",
    );
    expect(screen.getByText("Loading description")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("Updated")).toBeTruthy();
  });

  describe("the layout", () => {
    const stub = () =>
      stubServer({
        summary: () =>
          Response.json(
            summary({ labels: [{ name: "bug", color: "d73a4a" }] }),
          ),
        details: () => Response.json(details()),
      });

    it("lists the fields in the Properties aside, above the sections", async () => {
      stub();
      renderDetail();

      const aside = await screen.findByRole("complementary", {
        name: "Properties",
      });
      for (const label of ["Repository", "Author", "Created", "Labels"]) {
        expect(within(aside).getByText(label)).toBeTruthy();
      }
      expect(aside.className).not.toContain("lg:col-start-2");
    });

    it("puts the Properties aside beside the content in a wide layout", async () => {
      stub();
      renderDetail(vi.fn(), true);

      const aside = await screen.findByRole("complementary", {
        name: "Properties",
      });
      expect(aside.className).toContain("lg:col-start-2");
      expect(aside.className).toContain("lg:border-s");
      expect(within(aside).getByText("Repository")).toBeTruthy();
      const grid = aside.parentElement as HTMLElement;
      expect(grid.className).toContain("lg:grid-cols-");
      expect(
        within(grid).getByRole("heading", { name: "Widget fails to render" }),
      ).toBeTruthy();
      expect(await screen.findByText("fails")).toBeTruthy();
    });

    it("shows the skeleton and the not-found state in a wide layout", async () => {
      stubServer({
        summary: () => new Promise<Response>(() => undefined),
        details: () => new Promise<Response>(() => undefined),
      });
      renderDetail(vi.fn(), true);
      expect(
        screen.getByRole("status", { name: "Loading issue" }),
      ).toBeTruthy();
      cleanup();

      stubServer({
        summary: () => Response.json(errorBody("Not found"), { status: 404 }),
        details: () => Response.json(errorBody("Not found"), { status: 404 }),
      });
      renderDetail(vi.fn(), true);
      expect((await screen.findByRole("alert")).textContent).toContain(
        "No detail for acme/widgets#1",
      );
    });

    it("shows the retry in a wide layout when the summary fails", async () => {
      stubServer({
        summary: () => Response.json(errorBody("boom"), { status: 500 }),
        details: () => Response.json(details()),
      });
      renderDetail(vi.fn(), true);

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    });
  });

  it("renders the body in a markdown-body container when it arrives", async () => {
    stubServer({
      summary: () => Response.json(summary()),
      details: () => Response.json(details()),
    });
    renderDetail();

    const strong = await screen.findByText("fails");
    expect(strong.closest(".markdown-body")).not.toBeNull();
    expect(screen.queryByText("Loading description")).toBeNull();
  });

  it("lists comments oldest first with a link to the earlier ones", async () => {
    const comment = (n: number) => ({
      url: `https://github.com/acme/widgets/issues/1#issuecomment-${n}`,
      createdAt: Date.now() - (10 - n) * 3_600_000,
      author: `user${n}`,
      avatarUrl: null,
      bodyHtml: `<p>Comment ${n}</p>`,
    });
    stubServer({
      summary: () => Response.json(summary()),
      details: () =>
        Response.json(
          details({
            comments: [comment(1), comment(2)],
            commentsTotal: 102,
          }),
        ),
    });
    renderDetail();

    const list = await screen.findByRole("list", { name: "Comments" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("100 earlier comments on GitHub");
    expect(
      within(items[0] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/1");
    expect(items[1]?.textContent).toContain("user1");
    expect(items[2]?.textContent).toContain("user2");
    expect(
      screen.getByText("Comment 2").closest(".markdown-body"),
    ).not.toBeNull();
  });

  describe("the comment cards", () => {
    const comment = (n: number, author: string) => ({
      url: `https://github.com/acme/widgets/issues/1#issuecomment-${n}`,
      createdAt: Date.now() - (10 - n) * 3_600_000,
      author,
      avatarUrl: null,
      bodyHtml: `<p>Comment ${n}</p>`,
    });
    const stubComments = () =>
      stubServer({
        summary: () => Response.json(summary({ author: "octocat" })),
        details: () =>
          Response.json(
            details({
              comments: [
                comment(1, "hubot"),
                comment(2, "octocat"),
                comment(3, "ghost"),
              ],
              commentsTotal: 3,
            }),
          ),
      });
    const cards = (list: HTMLElement) => [
      ...list.querySelectorAll<HTMLElement>("[data-slot=card]"),
    ];

    it("renders one card per comment, with the avatar, author and time in its header", async () => {
      stubComments();
      renderDetail();

      const list = await screen.findByRole("list", { name: "Comments" });
      const [first, second, third] = cards(list);
      expect(cards(list)).toHaveLength(3);
      expect(first?.tagName).toBe("LI");
      for (const [card, author, n] of [
        [first, "hubot", 1],
        [second, "octocat", 2],
        [third, "ghost", 3],
      ] as const) {
        const header = card?.querySelector(
          "[data-slot=card-header]",
        ) as HTMLElement;
        expect(
          within(header)
            .getByRole("link", { name: new RegExp(`${author}$`) })
            .getAttribute("href"),
        ).toBe(`https://github.com/${author}`);
        expect(header.querySelector("[data-slot=avatar]")).not.toBeNull();
        expect(
          header.querySelector("time")?.closest("a")?.getAttribute("href"),
        ).toBe(
          `https://github.com/acme/widgets/issues/1#issuecomment-${String(n)}`,
        );
        expect(
          card?.querySelector("[data-slot=card-panel] .markdown-body")
            ?.textContent,
        ).toBe(`Comment ${String(n)}`);
      }
    });

    it("badges the comments of the issue's author and no others", async () => {
      stubComments();
      renderDetail();

      const list = await screen.findByRole("list", { name: "Comments" });
      const badged = cards(list).map((card) =>
        within(card).queryByText("Author") === null ? "no" : "yes",
      );
      expect(badged).toEqual(["no", "yes", "no"]);
    });

    it("keeps the link to earlier comments above the first card", async () => {
      stubServer({
        summary: () => Response.json(summary()),
        details: () =>
          Response.json(
            details({ comments: [comment(1, "hubot")], commentsTotal: 5 }),
          ),
      });
      renderDetail();

      const list = await screen.findByRole("list", { name: "Comments" });
      const items = within(list).getAllByRole("listitem");
      expect(items[0]?.getAttribute("data-slot")).toBeNull();
      expect(items[0]?.textContent).toContain("4 earlier comments on GitHub");
      expect(items[1]?.getAttribute("data-slot")).toBe("card");
    });
  });

  describe("the description card", () => {
    it("frames the description like a comment, headed by who opened the issue", async () => {
      stubServer({
        summary: () => Response.json(summary({ author: "octocat" })),
        details: () => Response.json(details()),
      });
      renderDetail();

      const body = await screen.findByText("fails");
      const card = body.closest("[data-slot=card]") as HTMLElement;
      const header = card.querySelector(
        "[data-slot=card-header]",
      ) as HTMLElement;
      expect(header.textContent).toContain("octocat");
      expect(header.textContent).toContain("opened this issue");
      expect(within(header).queryByText("Author")).toBeNull();
      expect(body.closest(".markdown-body")).not.toBeNull();
      expect(
        header.querySelector("time")?.closest("a")?.getAttribute("href"),
      ).toBe("https://github.com/acme/widgets/issues/1");
    });

    it("says so inside the card when there is no description", async () => {
      stubServer({
        summary: () => Response.json(summary()),
        details: () => Response.json(details({ bodyHtml: "" })),
      });
      renderDetail();

      const empty = await screen.findByText("No description provided.");
      expect(empty.closest("[data-slot=card]")).not.toBeNull();
    });
  });

  it("lists sub-issues with state and what lies beyond the first 50", async () => {
    stubServer({
      summary: () =>
        Response.json(summary({ subIssues: { total: 53, completed: 1 } })),
      details: () =>
        Response.json(
          details({
            subIssues: {
              total: 53,
              notAccessible: 1,
              items: [
                {
                  owner: "acme",
                  repo: "widgets",
                  number: 5,
                  title: "Done sub",
                  state: "CLOSED",
                  url: "https://github.com/acme/widgets/issues/5",
                },
                {
                  owner: "acme",
                  repo: "widgets",
                  number: 6,
                  title: "Open sub",
                  state: "OPEN",
                  url: "https://github.com/acme/widgets/issues/6",
                },
              ],
            },
          }),
        ),
    });
    renderDetail();

    const list = await screen.findByRole("list", { name: "Sub-issues" });
    expect(
      within(list).getByText("Done sub").closest("li")?.className,
    ).toContain("line-through");
    expect(
      within(list).getByText("Open sub").closest("li")?.className,
    ).not.toContain("line-through");
    expect(within(list).getByText("+1 not accessible").closest("a")).toBeNull();
    const more = within(list).getByText("+50 more on GitHub");
    expect(more.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/issues/1",
    );
  });

  it("shows no 'more' links for a short comment and sub-issue list", async () => {
    stubServer({
      summary: () =>
        Response.json(summary({ subIssues: { total: 1, completed: 0 } })),
      details: () =>
        Response.json(
          details({
            commentsTotal: 1,
            comments: [
              {
                url: "https://github.com/c/1",
                createdAt: Date.now(),
                author: "ghost",
                avatarUrl: null,
                bodyHtml: "<p>Only</p>",
              },
            ],
            subIssues: {
              total: 1,
              notAccessible: 0,
              items: [
                {
                  owner: "acme",
                  repo: "widgets",
                  number: 5,
                  title: "Only sub",
                  state: "OPEN",
                  url: "https://github.com/acme/widgets/issues/5",
                },
              ],
            },
          }),
        ),
    });
    renderDetail();

    await screen.findByText("Only sub");
    expect(screen.queryByText(/more on GitHub/)).toBeNull();
    expect(screen.queryByText(/earlier comment/)).toBeNull();
  });

  describe("the dependency lists", () => {
    const blockedBy = {
      open: 1,
      notAccessible: 2,
      items: [
        relation(2, { title: "Open blocker" }),
        relation(3, {
          title: "Closed blocker",
          state: "CLOSED",
          synced: false,
        }),
        relation(4, {
          owner: "other",
          repo: "repo",
          title: "Elsewhere",
          url: "https://github.com/other/repo/issues/4",
          synced: false,
        }),
      ],
    };

    it("shows repo#N, title and state, striking closed ones through", async () => {
      stubServer({
        summary: () => Response.json(summary({ blockedBy })),
        details: () => Response.json(details()),
      });
      renderDetail();

      const list = await screen.findByRole("list", { name: "Blocked by" });
      const open = within(list).getByText("Open blocker").closest("li");
      expect(open?.textContent).toContain("acme/widgets#2");
      expect(open?.textContent).toContain("open");
      expect(open?.className).not.toContain("line-through");
      const closed = within(list).getByText("Closed blocker").closest("li");
      expect(closed?.className).toContain("line-through");
      expect(closed?.textContent).toContain("closed");
    });

    it("opens a synced entry in the app and any other on GitHub", async () => {
      stubServer({
        summary: () => Response.json(summary({ blockedBy })),
        details: () => Response.json(details()),
      });
      const onOpenIssue = renderDetail();

      const list = await screen.findByRole("list", { name: "Blocked by" });
      const synced = within(list).getByRole("link", { name: "acme/widgets#2" });
      expect(synced.getAttribute("href")).toBe("/i/acme/widgets/2");
      expect(synced.getAttribute("target")).toBeNull();
      fireEvent.click(synced);
      expect(onOpenIssue).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        number: 2,
      });

      for (const name of ["acme/widgets#3", "other/repo#4"]) {
        const link = within(list).getByRole("link", { name });
        expect(link.getAttribute("href")).toMatch(/^https:\/\/github\.com\//);
        expect(link.getAttribute("target")).toBe("_blank");
        fireEvent.click(link);
      }
      expect(onOpenIssue).toHaveBeenCalledTimes(1);
    });

    it("ends with an unlinked '+N not accessible' only when N > 0", async () => {
      stubServer({
        summary: () =>
          Response.json(
            summary({
              blockedBy,
              blocking: {
                open: 1,
                notAccessible: 0,
                items: [relation(8, { title: "Blocked one" })],
              },
            }),
          ),
        details: () => Response.json(details()),
      });
      renderDetail();

      const list = await screen.findByRole("list", { name: "Blocked by" });
      const last = within(list).getAllByRole("listitem").at(-1);
      expect(last?.textContent).toBe("+2 not accessible");
      expect(last?.querySelector("a")).toBeNull();
      const blocking = screen.getByRole("list", { name: "Blocking" });
      expect(within(blocking).queryByText(/not accessible/)).toBeNull();
    });
  });

  describe("the dependency graph", () => {
    it("is shown in its own section when the issue has dependencies", async () => {
      stubServer({
        summary: () =>
          Response.json(
            summary({
              blocking: {
                open: 1,
                notAccessible: 0,
                items: [relation(8, { title: "Blocked one" })],
              },
            }),
          ),
        details: () => Response.json(details()),
      });
      const onOpenIssue = renderDetail();

      const graph = await screen.findByRole("group", {
        name: "Dependency graph",
      });
      expect(
        screen.getByRole("button", { name: /Dependency graph/ }),
      ).toBeTruthy();
      fireEvent.click(
        within(graph).getByRole("link", { name: /acme\/widgets#8/ }),
      );
      expect(onOpenIssue).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        number: 8,
      });
    });

    it("is left out when the issue has no dependencies", async () => {
      stubServer({
        summary: () => Response.json(summary()),
        details: () => Response.json(details()),
      });
      renderDetail();

      await screen.findByText("fails");
      expect(
        screen.queryByRole("group", { name: "Dependency graph" }),
      ).toBeNull();
      expect(screen.queryByText("Dependency graph")).toBeNull();
    });
  });

  describe("failures", () => {
    it("shows an Alert with a retry for the summary", async () => {
      let calls = 0;
      stubServer({
        summary: () =>
          ++calls === 1
            ? Response.json(errorBody("boom"), { status: 500 })
            : Response.json(summary()),
        details: () => Response.json(details()),
      });
      renderDetail();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Could not load the issue");
      expect(alert.textContent).toContain("boom");
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      expect(
        await screen.findByRole("heading", { name: "Widget fails to render" }),
      ).toBeTruthy();
      expect(calls).toBe(2);
    });

    it("keeps the summary and offers a retry when the details fail", async () => {
      let calls = 0;
      stubServer({
        summary: () => Response.json(summary()),
        details: () =>
          ++calls === 1
            ? Response.json(errorBody("GitHub could not return the details"), {
                status: 502,
              })
            : Response.json(details()),
      });
      renderDetail();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        "GitHub could not return the details",
      );
      expect(
        screen.getByRole("heading", { name: "Widget fails to render" }),
      ).toBeTruthy();
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("fails")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("tells when a spent budget resets (503)", async () => {
      const resetAt = Date.UTC(2030, 0, 1, 12, 0, 0);
      stubServer({
        summary: () => Response.json(summary()),
        details: () =>
          Response.json(
            errorBody("The GitHub rate limit is nearly spent", { resetAt }),
            { status: 503 },
          ),
      });
      renderDetail();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("nearly spent");
      expect(alert.textContent).toContain(
        new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "medium",
        }).format(resetAt),
      );
    });

    it("says so, without a retry, for an issue that has no detail (404)", async () => {
      stubServer({
        summary: () => Response.json(errorBody("Not found"), { status: 404 }),
        details: () => Response.json(errorBody("Not found"), { status: 404 }),
      });
      renderDetail();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("No detail for acme/widgets#1");
      expect(within(alert).queryByRole("button")).toBeNull();
    });

    it("never turns a failed request into an empty description", async () => {
      stubServer({
        summary: () => Response.json(summary()),
        details: () => Response.error(),
      });
      renderDetail();

      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeTruthy();
      });
      expect(screen.queryByText("No description provided.")).toBeNull();
    });
  });

  describe("stale copies", () => {
    it("marks a stale body as possibly out of date and still shows it", async () => {
      stubServer({
        summary: () => Response.json(summary()),
        details: () => Response.json(details({ stale: true })),
      });
      renderDetail();

      expect(await screen.findByText("fails")).toBeTruthy();
      expect(screen.getByText("This copy may be out of date")).toBeTruthy();
    });

    it("shows no warning for a fresh copy", async () => {
      stubServer({
        summary: () => Response.json(summary()),
        details: () => Response.json(details()),
      });
      renderDetail();

      await screen.findByText("fails");
      expect(screen.queryByText("This copy may be out of date")).toBeNull();
    });
  });

  it("says when an issue has no description", async () => {
    stubServer({
      summary: () => Response.json(summary()),
      details: () => Response.json(details({ bodyHtml: "" })),
    });
    renderDetail();

    expect(await screen.findByText("No description provided.")).toBeTruthy();
  });
});
