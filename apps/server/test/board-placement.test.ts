import { describe, expect, it } from "vitest";
import { OTHER, placeIssues, type Slot } from "../src/boards/index.js";
import { nestCards, type CardOf } from "../src/issues/index.js";

interface Node {
  id: string;
  repo: { owner: string; name: string };
  number: number;
  parent: { owner: string; repo: string; number: number } | null;
}

const node = (number: number, parent: number | null = null): Node => ({
  id: `I${String(number)}`,
  repo: { owner: "acme", name: "web" },
  number,
  parent:
    parent === null ? null : { owner: "acme", repo: "web", number: parent },
});

const ids = (cards: readonly CardOf<Node>[] | undefined) =>
  (cards ?? []).map((card) => card.id);

const names = ["Todo", "Doing"];

function nest(
  synced: Node[],
  placed: [number, Slot][],
  mode: "collapsed" | "expanded" = "collapsed",
) {
  return nestCards({
    synced,
    placed: new Map(
      placed.map(([number, slot]) => [`I${String(number)}`, slot]),
    ),
    toCard: (issue) => ({ ...issue }),
    slotName: (slot) => (slot === OTHER ? "Other" : (names[slot] ?? "")),
    mode,
  });
}

describe("placeIssues", () => {
  const issues = [1, 2, 3, 4].map((number) => node(number));
  const matchers = [
    (issue: Node) => issue.number <= 2,
    (issue: Node) => issue.number <= 3,
  ];

  it("places an issue in the first column, in order, whose filter matches", () => {
    const placed = placeIssues(issues, matchers, false);
    expect(placed.get("I1")).toBe(0);
    expect(placed.get("I2")).toBe(0);
    expect(placed.get("I3")).toBe(1);
  });

  it("leaves an issue no column matches out unless Other is enabled", () => {
    expect(placeIssues(issues, matchers, false).has("I4")).toBe(false);
    expect(placeIssues(issues, matchers, true).get("I4")).toBe(OTHER);
  });
});

describe("nestCards", () => {
  it("nests an issue under its placed parent with its own column name", () => {
    const slots = nest(
      [node(1), node(2, 1)],
      [
        [1, 0],
        [2, 1],
      ],
    );
    expect(ids(slots.get(0))).toEqual(["I1"]);
    expect(slots.has(1)).toBe(false);
    const [parent] = slots.get(0) ?? [];
    expect(ids(parent?.children)).toEqual(["I2"]);
    expect(parent?.children?.[0]).toMatchObject({
      columnName: "Doing",
      children: [],
    });
    expect(parent?.columnName).toBeUndefined();
  });

  it("nests through a synced ancestor that is not placed", () => {
    const slots = nest(
      [node(1), node(2, 1), node(3, 2)],
      [
        [1, 0],
        [3, OTHER],
      ],
    );
    expect(ids(slots.get(0))).toEqual(["I1"]);
    const [top] = slots.get(0) ?? [];
    expect(ids(top?.children)).toEqual(["I3"]);
    expect(top?.children?.[0]?.columnName).toBe("Other");
    expect(slots.has(OTHER)).toBe(false);
  });

  it("nests sub-issues of sub-issues", () => {
    const slots = nest(
      [node(1), node(2, 1), node(3, 2)],
      [
        [1, 0],
        [2, 0],
        [3, 1],
      ],
    );
    const [top] = slots.get(0) ?? [];
    expect(ids(slots.get(0))).toEqual(["I1"]);
    expect(ids(top?.children)).toEqual(["I2"]);
    expect(ids(top?.children?.[0]?.children)).toEqual(["I3"]);
  });

  it("ends a chain at a parent that is not synced", () => {
    const slots = nest(
      [node(1), node(3, 2)],
      [
        [1, 0],
        [3, 0],
      ],
    );
    expect(ids(slots.get(0))).toEqual(["I1", "I3"]);
    expect(slots.get(0)?.[0]?.children).toEqual([]);
  });

  it("does not look past an unsynced parent for a placed ancestor", () => {
    const grandchild = node(3, 99);
    const slots = nest(
      [node(1), grandchild],
      [
        [1, 0],
        [3, 0],
      ],
    );
    expect(ids(slots.get(0))).toEqual(["I1", "I3"]);
  });

  it("ends a chain before an issue it has already visited", () => {
    const slots = nest(
      [node(1, 3), node(2, 1), node(3, 2), node(4, 3)],
      [[4, 0]],
    );
    expect(ids(slots.get(0))).toEqual(["I4"]);
    expect(slots.get(0)?.[0]?.children).toEqual([]);
  });

  it("keeps every placed issue visible when placed issues are each other's ancestors", () => {
    const slots = nest(
      [node(1, 2), node(2, 1)],
      [
        [1, 0],
        [2, 1],
      ],
    );
    expect(ids(slots.get(0))).toEqual(["I1"]);
    expect(ids(slots.get(0)?.[0]?.children)).toEqual(["I2"]);
  });

  it("treats a placed issue that is its own parent as top-level", () => {
    const slots = nest([node(1, 1)], [[1, 0]]);
    expect(ids(slots.get(0))).toEqual(["I1"]);
  });

  it("makes every placed issue its own card in expanded mode", () => {
    const slots = nest(
      [node(1), node(2, 1)],
      [
        [1, 0],
        [2, 1],
      ],
      "expanded",
    );
    expect(ids(slots.get(0))).toEqual(["I1"]);
    expect(ids(slots.get(1))).toEqual(["I2"]);
    expect(slots.get(0)?.[0]?.children).toBeUndefined();
    expect(slots.get(1)?.[0]?.columnName).toBeUndefined();
  });

  it("keeps the order of the synced list", () => {
    const slots = nest(
      [node(3), node(1), node(2)],
      [
        [1, 0],
        [2, 0],
        [3, 0],
      ],
    );
    expect(ids(slots.get(0))).toEqual(["I3", "I1", "I2"]);
  });
});
