import { describe, expect, it } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import {
  loadedIssues,
  parseIndexSearch,
  visibleRows,
  type IssueItem,
  type IssueList,
} from "@/lib/issues";

const issue = (id: string, title: string) =>
  ({ id, title }) as unknown as IssueItem;

const pages = (...items: IssueItem[][]): InfiniteData<IssueList> => ({
  pages: items.map((page) => ({ items: page, total: 4 }) as IssueList),
  pageParams: items.map((_, index) => index),
});

describe("loadedIssues", () => {
  it("returns no rows before the first page arrives", () => {
    expect(loadedIssues(undefined)).toEqual([]);
  });

  it("keeps only the first copy of an issue that two pages return", () => {
    const rows = loadedIssues(
      pages(
        [issue("a", "A"), issue("b", "B")],
        [issue("b", "B moved"), issue("c", "C")],
      ),
    );

    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(rows[1]?.title).toBe("B");
  });
});

describe("parseIndexSearch", () => {
  it("reads ?nest=1 as the nesting mode and drops any other value", () => {
    expect(parseIndexSearch({ nest: 1 })).toEqual({ nest: 1 });
    expect(parseIndexSearch({ nest: "1" })).toEqual({ nest: 1 });
    expect(parseIndexSearch({ nest: true })).toEqual({ nest: 1 });
    expect(parseIndexSearch({ nest: 0 })).toEqual({});
    expect(parseIndexSearch({ nest: "yes" })).toEqual({});
    expect(parseIndexSearch({})).toEqual({});
  });
});

describe("visibleRows", () => {
  const node = (id: string, children?: IssueItem[]) =>
    ({ id, ...(children === undefined ? {} : { children }) }) as IssueItem;
  const tree = [node("a", [node("b", [node("c")]), node("d")]), node("e", [])];

  it("lists only the top-level issues while nothing is expanded", () => {
    const rows = visibleRows(tree, () => false);
    expect(rows.map((row) => row.issue.id)).toEqual(["a", "e"]);
    expect(rows.map((row) => row.expandable)).toEqual([true, false]);
  });

  it("lists the children of an expanded issue at any depth", () => {
    const rows = visibleRows(tree, (id) => id === "a" || id === "b");
    expect(rows.map((row) => [row.issue.id, row.depth, row.under?.id])).toEqual(
      [
        ["a", 0, undefined],
        ["b", 1, "a"],
        ["c", 2, "b"],
        ["d", 1, "a"],
        ["e", 0, undefined],
      ],
    );
  });

  it("hides the grandchildren of a collapsed child", () => {
    const rows = visibleRows(tree, (id) => id === "a");
    expect(rows.map((row) => row.issue.id)).toEqual(["a", "b", "d", "e"]);
  });

  it("keeps an issue that is returned twice at its first place", () => {
    const rows = visibleRows([node("a", [node("x")]), node("x")], () => true);
    expect(rows.map((row) => row.issue.id)).toEqual(["a", "x"]);
  });
});
