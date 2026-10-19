import type { Slot } from "./placement.js";

/** What nesting needs of an issue: its identity and the parent it names. */
export interface NestableIssue {
  id: string;
  repo: { owner: string; name: string };
  number: number;
  parent: { owner: string; repo: string; number: number } | null;
}

/** A card: the issue item, its nested cards (collapsed mode) and, once nested, its column. */
export type CardOf<T> = T & { children?: CardOf<T>[]; columnName?: string };

const issueKey = (owner: string, repo: string, number: number) =>
  `${owner}/${repo}#${String(number)}`.toLowerCase();

/**
 * The nearest placed ancestor of each placed issue (SPEC FR-31): the chain
 * follows the parent of each issue across synced issues only, passes over a
 * synced ancestor that is not placed, ends at a parent that is not synced
 * (absent from `synced`) and ends before an issue it has already visited.
 */
function nearestPlacedAncestors<T extends NestableIssue>(
  synced: readonly T[],
  placed: ReadonlyMap<string, Slot>,
): Map<string, string> {
  const byKey = new Map(
    synced.map((issue) => [
      issueKey(issue.repo.owner, issue.repo.name, issue.number),
      issue,
    ]),
  );
  const ancestorOf = new Map<string, string>();
  for (const issue of synced) {
    if (!placed.has(issue.id)) continue;
    const visited = new Set([issue.id]);
    let current: T = issue;
    for (;;) {
      const parent = current.parent;
      if (parent === null) break;
      const next = byKey.get(
        issueKey(parent.owner, parent.repo, parent.number),
      );
      if (next === undefined || visited.has(next.id)) break;
      if (placed.has(next.id)) {
        ancestorOf.set(issue.id, next.id);
        break;
      }
      visited.add(next.id);
      current = next;
    }
  }
  return ancestorOf;
}

/**
 * Makes the nearest-ancestor links acyclic. Two placed issues that name each
 * other as nearest ancestor would both be nested and neither shown, so in
 * each such loop the issue that comes first in `ordered` stays top-level.
 */
function breakCycles(
  ancestorOf: Map<string, string>,
  ordered: readonly string[],
): void {
  const rank = new Map(ordered.map((id, index) => [id, index]));
  const settled = new Set<string>();
  for (const start of ordered) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !settled.has(current)) {
      if (onPath.has(current)) {
        const loop = path.slice(path.indexOf(current));
        const head = loop.reduce((first, id) =>
          (rank.get(id) ?? 0) < (rank.get(first) ?? 0) ? id : first,
        );
        ancestorOf.delete(head);
        break;
      }
      onPath.add(current);
      path.push(current);
      current = ancestorOf.get(current);
    }
    for (const id of path) settled.add(id);
  }
}

export interface NestOptions<T> {
  /** Every synced issue of the viewer, in the board's sort order. */
  synced: readonly T[];
  /** The slot of each placed issue (`placeIssues`). */
  placed: ReadonlyMap<string, Slot>;
  /** Wraps an issue into the card it is shown as. */
  toCard: (issue: T) => CardOf<T>;
  /** The name shown on a nested card for the slot it was placed in. */
  slotName: (slot: Slot) => string;
  mode: "collapsed" | "expanded";
}

/**
 * Builds the top-level cards of each slot, in the order of `synced`. In
 * collapsed mode an issue with a nearest placed ancestor is listed in that
 * ancestor's `children` with its own `columnName` instead of as a top-level
 * card (SPEC FR-31); in expanded mode every placed issue is its own card.
 */
export function nestCards<T extends NestableIssue>(
  options: NestOptions<T>,
): Map<Slot, CardOf<T>[]> {
  const { synced, placed, toCard, slotName, mode } = options;
  const ordered = synced.filter((issue) => placed.has(issue.id));
  const ancestorOf =
    mode === "collapsed"
      ? nearestPlacedAncestors(synced, placed)
      : new Map<string, string>();
  breakCycles(
    ancestorOf,
    ordered.map((issue) => issue.id),
  );

  const cards = new Map(
    ordered.map((issue) => [
      issue.id,
      mode === "collapsed" ? { ...toCard(issue), children: [] } : toCard(issue),
    ]),
  );
  const slots = new Map<Slot, CardOf<T>[]>();
  for (const issue of ordered) {
    const card = cards.get(issue.id);
    const slot = placed.get(issue.id);
    if (card === undefined || slot === undefined) continue;
    const ancestor = cards.get(ancestorOf.get(issue.id) ?? "");
    if (ancestor?.children !== undefined) {
      card.columnName = slotName(slot);
      ancestor.children.push(card);
    } else {
      const list = slots.get(slot);
      if (list === undefined) slots.set(slot, [card]);
      else list.push(card);
    }
  }
  return slots;
}
