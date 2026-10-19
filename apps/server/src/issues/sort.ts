import type { Sort } from "../api/schemas.js";
import type { AccessibleIssue } from "./filterable.js";

const lower = (value: string) => value.toLowerCase();

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Repo then number: the order `repo-asc` uses and every other sort falls back to. */
function byRepoAndNumber(a: AccessibleIssue, b: AccessibleIssue): number {
  return (
    compareText(lower(a.item.repo.owner), lower(b.item.repo.owner)) ||
    compareText(lower(a.item.repo.name), lower(b.item.repo.name)) ||
    a.item.number - b.item.number
  );
}

const COMPARATORS: Record<
  Sort,
  (a: AccessibleIssue, b: AccessibleIssue) => number
> = {
  "updated-desc": (a, b) => b.item.updatedAt - a.item.updatedAt,
  "updated-asc": (a, b) => a.item.updatedAt - b.item.updatedAt,
  "created-desc": (a, b) => b.item.createdAt - a.item.createdAt,
  "created-asc": (a, b) => a.item.createdAt - b.item.createdAt,
  "repo-asc": () => 0,
  "title-asc": (a, b) => compareText(lower(a.item.title), lower(b.item.title)),
};

/** Sorts a copy (SPEC FR-13); ties fall back to repo then number so pages are stable. */
export function sortIssues(
  list: readonly AccessibleIssue[],
  sort: Sort,
): AccessibleIssue[] {
  const compare = COMPARATORS[sort];
  return [...list].sort((a, b) => compare(a, b) || byRepoAndNumber(a, b));
}
