import { describe, expect, it } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import { loadedIssues, type IssueItem, type IssueList } from "@/lib/issues";

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
