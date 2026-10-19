/** Where a placed issue lands: a column by its position, or the "Other" slot. */
export type Slot = number | "other";

export const OTHER = "other" as const;

/**
 * Places each issue in the first column, in column order, whose filter
 * matches it; an issue no column matches goes to "Other" when it is enabled,
 * otherwise it is left out (SPEC FR-30). The issues are the candidates that
 * already passed the base filter and the ad-hoc filter. Returns the slot of
 * every placed issue by its id.
 */
export function placeIssues<T extends { id: string }>(
  candidates: readonly T[],
  columnMatches: readonly ((issue: T) => boolean)[],
  showOther: boolean,
): Map<string, Slot> {
  const placed = new Map<string, Slot>();
  for (const issue of candidates) {
    const column = columnMatches.findIndex((matches) => matches(issue));
    if (column !== -1) {
      placed.set(issue.id, column);
    } else if (showOther) {
      placed.set(issue.id, OTHER);
    }
  }
  return placed;
}
