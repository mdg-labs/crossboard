import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyGraph } from "@/components/detail/dependency-graph/dependency-graph";
import {
  hasDependencies,
  layoutGraph,
  MAX_NODE_WIDTH,
  MAX_NODES_PER_SIDE,
  MIN_NODE_WIDTH,
  truncateTitle,
} from "@/components/detail/dependency-graph/layout";
import { relation, summary } from "@/components/detail/test-data";
import type { IssueRelation, IssueSummary } from "@/lib/issue-detail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const many = (count: number, start = 100): IssueRelation[] =>
  Array.from({ length: count }, (_, index) => relation(start + index));

function relations(items: IssueRelation[], notAccessible = 0) {
  return {
    open: items.filter((item) => item.state === "OPEN").length,
    notAccessible,
    items,
  };
}

function draw(
  overrides: Partial<IssueSummary>,
  onOpenIssue = vi.fn(),
  containerWidth?: number,
) {
  if (containerWidth !== undefined) {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      containerWidth,
    );
  }
  const { container } = render(
    <DependencyGraph onOpenIssue={onOpenIssue} summary={summary(overrides)} />,
  );
  return { container, onOpenIssue };
}

const nodes = (container: HTMLElement, side: string, kind = "issue") =>
  container.querySelectorAll(`[data-side="${side}"][data-node="${kind}"]`);

describe("the dependency graph", () => {
  it("draws blockers, the issue and the blocked issues in three columns", () => {
    const { container } = draw({
      blockedBy: relations([relation(2), relation(3)]),
      blocking: relations([relation(4)]),
    });

    expect(nodes(container, "blockers")).toHaveLength(2);
    expect(nodes(container, "issue")).toHaveLength(1);
    expect(nodes(container, "blocked")).toHaveLength(1);
    const x = (side: string) =>
      Number(
        nodes(container, side)[0]
          ?.querySelector("g[transform]")
          ?.getAttribute("transform")
          ?.match(/translate\(([\d.]+)/)?.[1],
      );
    expect(x("blockers")).toBeLessThan(x("issue"));
    expect(x("issue")).toBeLessThan(x("blocked"));
  });

  it("joins each blocker to the issue and the issue to each blocked issue", () => {
    const { container } = draw({
      blockedBy: relations([relation(2), relation(3)]),
      blocking: relations([relation(4)]),
    });

    const edges = [...container.querySelectorAll("path[data-edge]")];
    expect(edges.map((edge) => edge.getAttribute("data-edge"))).toEqual([
      "blockers:acme/widgets#2->issue",
      "blockers:acme/widgets#3->issue",
      "issue->blocked:acme/widgets#4",
    ]);
    const end = (edge: Element | undefined) =>
      edge?.getAttribute("d")?.split(" ").slice(-2).join(" ");
    const [first, second] = edges;
    expect(end(first)).toBe(end(second));
  });

  it("draws every edge as a cubic curve ending in the arrow marker", () => {
    const { container } = draw({
      blockedBy: relations([relation(2)]),
      blocking: relations([relation(4)]),
    });

    const edges = [...container.querySelectorAll("path[data-edge]")];
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.getAttribute("d")).toMatch(/^M[\d. ]+C[\d. ]+$/);
      expect(edge.getAttribute("marker-end")).toMatch(/^url\(#.+\)$/);
    }
  });

  it("shows repo#N and the title cut to 40 characters", () => {
    const title = "A very long issue title that does not fit in a node at all";
    draw({
      blockedBy: relations([relation(2, { title })]),
    });

    expect(screen.getByText("widgets#2")).toBeTruthy();
    const shown = screen.getByText(truncateTitle(title));
    expect(shown.textContent).toHaveLength(40);
    expect(shown.textContent?.endsWith("…")).toBe(true);
    expect(screen.queryByText(title)).toBeNull();
  });

  it("keeps a title of 40 characters or fewer whole", () => {
    expect(truncateTitle("x".repeat(40))).toBe("x".repeat(40));
    expect(truncateTitle("x".repeat(41))).toHaveLength(40);
  });

  it("strikes closed nodes through and greys them", () => {
    draw({
      blockedBy: relations([
        relation(2, { title: "Still open" }),
        relation(3, { title: "Already done", state: "CLOSED" }),
      ]),
    });

    const closed = screen.getByText("Already done");
    expect(closed.style.textDecoration).toBe("line-through");
    expect(closed.getAttribute("class")).toContain("fill-muted-foreground");
    expect(closed.closest("g[transform]")?.getAttribute("class")).toContain(
      "opacity-70",
    );
    const open = screen.getByText("Still open");
    expect(open.style.textDecoration).toBe("");
    expect(open.getAttribute("class")).toContain("fill-foreground");
  });

  it("colors the graph from theme tokens only", () => {
    const { container } = draw({
      blockedBy: relations([relation(2)]),
      blocking: relations([relation(4)]),
    });

    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
    for (const rect of container.querySelectorAll("rect")) {
      expect(rect.getAttribute("class")).toMatch(
        /fill-(card|muted|destructive)/,
      );
      expect(rect.getAttribute("class")).toContain("stroke-");
    }
  });

  describe("headings", () => {
    it("name each non-empty column with its count", () => {
      const { container } = draw({
        blockedBy: relations([relation(2), relation(3)], 1),
        blocking: relations([relation(4)]),
      });

      const headings = [...container.querySelectorAll("text[data-heading]")];
      expect(headings.map((heading) => heading.textContent)).toEqual([
        "Blocked by 3",
        "This issue",
        "Blocking 1",
      ]);
    });

    it("leave out a side without relations", () => {
      const { container } = draw({ blocking: relations([relation(4)]) });

      const headings = [...container.querySelectorAll("text[data-heading]")];
      expect(headings.map((heading) => heading.textContent)).toEqual([
        "This issue",
        "Blocking 1",
      ]);
    });
  });

  describe("highlighting an edge", () => {
    const edge = (container: HTMLElement, key: string) =>
      container.querySelector(`path[data-edge="${key}"]`) as Element;

    it("marks the edge of the focused node and clears it on blur", () => {
      const { container } = draw({
        blockedBy: relations([relation(2), relation(3)]),
        blocking: relations([relation(4)]),
      });
      const link = screen.getByRole("link", { name: /acme\/widgets#2/ });

      expect(container.querySelector("[data-highlighted]")).toBeNull();
      fireEvent.focus(link);
      expect(
        edge(container, "blockers:acme/widgets#2->issue").getAttribute(
          "data-highlighted",
        ),
      ).toBe("true");
      expect(container.querySelectorAll("[data-highlighted]")).toHaveLength(1);
      fireEvent.blur(link);
      expect(container.querySelector("[data-highlighted]")).toBeNull();
    });

    it("marks the edge of the hovered node", () => {
      const { container } = draw({ blocking: relations([relation(4)]) });
      const node = container.querySelector(
        '[data-side="blocked"][data-node="issue"]',
      ) as Element;

      fireEvent.pointerEnter(node);
      expect(
        edge(container, "issue->blocked:acme/widgets#4").getAttribute(
          "data-highlighted",
        ),
      ).toBe("true");
      fireEvent.pointerLeave(node);
      expect(container.querySelector("[data-highlighted]")).toBeNull();
    });

    it("marks the edge of a '+N' node", () => {
      const { container } = draw({ blockedBy: relations([], 2) });
      const node = container.querySelector('[data-node="hidden"]') as Element;

      fireEvent.pointerEnter(node);
      expect(
        edge(container, "blockers:hidden->issue").getAttribute(
          "data-highlighted",
        ),
      ).toBe("true");
    });
  });

  describe("the blocking tint", () => {
    it("marks an open blocker and neither a closed one nor a blocked issue", () => {
      const { container } = draw({
        blockedBy: relations([
          relation(2, { title: "Open blocker" }),
          relation(3, { title: "Closed blocker", state: "CLOSED" }),
        ]),
        blocking: relations([relation(4, { title: "Blocked one" })]),
      });

      const box = (title: string) =>
        screen.getByText(title).closest("g[transform]") as Element;
      expect(box("Open blocker").getAttribute("data-blocking")).toBe("true");
      expect(
        box("Open blocker").querySelector("rect")?.getAttribute("class"),
      ).toContain("fill-destructive");
      for (const title of ["Closed blocker", "Blocked one"]) {
        expect(box(title).getAttribute("data-blocking")).toBeNull();
        expect(
          box(title).querySelector("rect")?.getAttribute("class"),
        ).not.toContain("destructive");
      }
      expect(
        container.querySelector('[data-side="issue"] [data-blocking]'),
      ).toBeNull();
    });

    it("names an open blocker in its label", () => {
      draw({ blockedBy: relations([relation(2)]) });

      expect(
        screen.getByRole("link", { name: /acme\/widgets#2.*\(open blocker\)/ }),
      ).toBeTruthy();
    });
  });

  describe("fitting the container", () => {
    const deps = summary({
      blockedBy: relations([relation(2), relation(3)]),
      blocking: relations([relation(4)], 2),
    });

    it("never lays out wider than the width it is given", () => {
      for (let width = 120; width <= 1400; width += 7) {
        expect(layoutGraph(deps, width).width).toBeLessThanOrEqual(
          Math.max(width, 100),
        );
      }
    });

    it("uses three columns of at least the floor width at the default panel width", () => {
      const layout = layoutGraph(deps, 624);

      expect(layout.mode).toBe("columns");
      expect(layout.width).toBeLessThanOrEqual(624);
      expect(layout.nodeWidth).toBeGreaterThanOrEqual(MIN_NODE_WIDTH);
    });

    it("widens the nodes with the width, up to a cap", () => {
      const narrow = layoutGraph(deps, 624).nodeWidth;
      const wide = layoutGraph(deps, 900).nodeWidth;

      expect(wide).toBeGreaterThan(narrow);
      expect(layoutGraph(deps, 3000).nodeWidth).toBe(MAX_NODE_WIDTH);
    });

    it("stacks the groups vertically below the floor width", () => {
      const layout = layoutGraph(deps, 400);

      expect(layout.mode).toBe("stacked");
      expect(layout.width).toBeLessThanOrEqual(400);
      const y = (side: string) =>
        layout.nodes.filter((node) => node.side === side).map((node) => node.y);
      const x = new Set(layout.nodes.map((node) => node.x));
      expect(x.size).toBe(1);
      expect(Math.max(...y("blockers"))).toBeLessThan(Math.min(...y("issue")));
      expect(Math.max(...y("issue"))).toBeLessThan(Math.min(...y("blocked")));
      expect(layout.headings.map((heading) => heading.text)).toEqual([
        "Blocked by 2",
        "This issue",
        "Blocking 3",
      ]);
    });

    it("switches to the stacked layout exactly where three columns stop fitting", () => {
      let width = 120;
      while (layoutGraph(deps, width).mode === "stacked") {
        width += 1;
      }

      expect(layoutGraph(deps, width).nodeWidth).toBe(MIN_NODE_WIDTH);
      expect(layoutGraph(deps, width - 1).mode).toBe("stacked");
    });

    it("renders the layout for the measured container", () => {
      const { container } = draw(deps, vi.fn(), 624);

      const svg = container.querySelector("svg[data-mode]") as Element;
      expect(svg.getAttribute("data-mode")).toBe("columns");
      expect(Number(svg.getAttribute("width"))).toBeLessThanOrEqual(624);
      expect(svg.getAttribute("class")).not.toContain("min-w-");
    });

    it("renders stacked in a narrow container", () => {
      const { container } = draw(deps, vi.fn(), 360);

      const svg = container.querySelector("svg[data-mode]") as Element;
      expect(svg.getAttribute("data-mode")).toBe("stacked");
      expect(Number(svg.getAttribute("width"))).toBeLessThanOrEqual(360);
    });
  });

  describe("the limit of 15 nodes per side", () => {
    it("draws 15 blockers and no '+N more' node for exactly 15", () => {
      const { container } = draw({
        blockedBy: relations(many(MAX_NODES_PER_SIDE)),
      });

      expect(nodes(container, "blockers")).toHaveLength(15);
      expect(nodes(container, "blockers", "more")).toHaveLength(0);
    });

    it("replaces the 16th and later blockers by one '+N more' node", () => {
      const { container } = draw({ blockedBy: relations(many(20)) });

      expect(nodes(container, "blockers")).toHaveLength(15);
      const more = nodes(container, "blockers", "more");
      expect(more).toHaveLength(1);
      expect(more[0]?.textContent).toBe("+5 more");
      expect(more[0]?.querySelector("a")).toBeNull();
      expect(screen.queryByText("widgets#115")).toBeNull();
      expect(screen.getByText("widgets#114")).toBeTruthy();
    });

    it("limits the blocked side the same way", () => {
      const { container } = draw({ blocking: relations(many(16)) });

      expect(nodes(container, "blocked")).toHaveLength(15);
      expect(nodes(container, "blocked", "more")[0]?.textContent).toBe(
        "+1 more",
      );
    });
  });

  describe("relations the viewer cannot read", () => {
    it("are one '+N not accessible' node without a link", () => {
      const { container } = draw({
        blockedBy: relations([relation(2)], 3),
        blocking: relations([], 2),
      });

      const hidden = nodes(container, "blockers", "hidden");
      expect(hidden).toHaveLength(1);
      expect(hidden[0]?.textContent).toBe("+3 not accessible");
      expect(hidden[0]?.querySelector("a")).toBeNull();
      expect(nodes(container, "blocked", "hidden")[0]?.textContent).toBe(
        "+2 not accessible",
      );
    });

    it("follow the '+N more' node when both apply", () => {
      const { container } = draw({ blockedBy: relations(many(17), 4) });

      const side = [...container.querySelectorAll('[data-side="blockers"]')];
      expect(side.map((node) => node.getAttribute("data-node"))).toEqual([
        ...Array<string>(15).fill("issue"),
        "more",
        "hidden",
      ]);
    });
  });

  describe("clicking a node", () => {
    it("opens a synced issue's detail in the app", () => {
      const { onOpenIssue } = draw({
        blockedBy: relations([relation(2, { title: "Synced one" })]),
      });

      const link = screen.getByRole("link", { name: /acme\/widgets#2/ });
      expect(link.getAttribute("href")).toBe("/i/acme/widgets/2");
      fireEvent.click(link);
      expect(onOpenIssue).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        number: 2,
      });
    });

    it("sends any other issue to GitHub", () => {
      const { onOpenIssue } = draw({
        blocking: relations([
          relation(5, {
            synced: false,
            url: "https://github.com/other/place/issues/5",
          }),
        ]),
      });

      const link = screen.getByRole("link", { name: /acme\/widgets#5/ });
      expect(link.getAttribute("href")).toBe(
        "https://github.com/other/place/issues/5",
      );
      expect(link.getAttribute("target")).toBe("_blank");
      fireEvent.click(link);
      expect(onOpenIssue).not.toHaveBeenCalled();
    });

    it("names a closed node as closed", () => {
      draw({
        blockedBy: relations([relation(3, { state: "CLOSED", synced: false })]),
      });

      expect(
        screen.getByRole("link", { name: /acme\/widgets#3.*\(closed\)/ }),
      ).toBeTruthy();
    });
  });

  describe("without dependencies", () => {
    it("is omitted", () => {
      const { container } = draw({});

      expect(container.querySelector("svg")).toBeNull();
      expect(hasDependencies(summary({}))).toBe(false);
    });

    it("is drawn for a single not-accessible relation", () => {
      const { container } = draw({ blocking: relations([], 1) });

      expect(container.querySelector("svg")).not.toBeNull();
      expect(hasDependencies(summary({ blocking: relations([], 1) }))).toBe(
        true,
      );
    });
  });
});
