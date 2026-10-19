import type { IssueRef, IssueRelation, IssueSummary } from "@/lib/issue-detail";

/** At most this many relations are drawn on each side (SPEC FR-27). */
export const MAX_NODES_PER_SIDE = 15;
/** Titles are cut to this many characters, ellipsis included. */
export const MAX_TITLE_LENGTH = 40;

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 44;
const ROW_GAP = 10;
const COLUMN_GAP = 32;
const PADDING = 4;

export type Side = "blockers" | "issue" | "blocked";

interface Identified {
  key: string;
  side: Side;
}

type NodeContent =
  | {
      kind: "issue";
      ref: IssueRef;
      title: string;
      closed: boolean;
      url: string;
      /** Whether the issue has a detail view in the app. */
      synced: boolean;
    }
  | { kind: "more" | "hidden"; label: string };

type Unplaced = Identified & NodeContent;

export type GraphNode = Unplaced & { x: number; y: number };

export interface GraphEdge {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** An edge to a "+N" node stands for several issues. */
  summary: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function truncateTitle(title: string): string {
  const characters = Array.from(title);
  return characters.length <= MAX_TITLE_LENGTH
    ? title
    : `${characters.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`;
}

type Relations = IssueSummary["blockedBy"];

/** Whether the issue has any relation, readable or not (SPEC FR-27). */
export const hasDependencies = (
  summary: Pick<IssueSummary, "blockedBy" | "blocking">,
): boolean =>
  summary.blockedBy.items.length +
    summary.blockedBy.notAccessible +
    summary.blocking.items.length +
    summary.blocking.notAccessible >
  0;

function sideNodes(side: Side, relations: Relations): Unplaced[] {
  const drawn = relations.items.slice(0, MAX_NODES_PER_SIDE);
  const nodes: Unplaced[] = drawn.map((entry: IssueRelation) => ({
    kind: "issue",
    key: `${side}:${entry.owner}/${entry.repo}#${String(entry.number)}`,
    side,
    ref: { owner: entry.owner, repo: entry.repo, number: entry.number },
    title: entry.title,
    closed: entry.state === "CLOSED",
    url: entry.url,
    synced: entry.synced,
  }));
  const more = relations.items.length - drawn.length;
  if (more > 0) {
    nodes.push({
      kind: "more",
      key: `${side}:more`,
      side,
      label: `+${String(more)} more`,
    });
  }
  if (relations.notAccessible > 0) {
    nodes.push({
      kind: "hidden",
      key: `${side}:hidden`,
      side,
      label: `+${String(relations.notAccessible)} not accessible`,
    });
  }
  return nodes;
}

/** Three columns: the blockers, the issue, the issues it blocks (SPEC FR-27). */
export function layoutGraph(summary: IssueSummary): GraphLayout {
  const blockers = sideNodes("blockers", summary.blockedBy);
  const blocked = sideNodes("blocked", summary.blocking);
  const rows = Math.max(blockers.length, blocked.length, 1);
  const height = rows * NODE_HEIGHT + (rows - 1) * ROW_GAP + 2 * PADDING;
  const width = 3 * NODE_WIDTH + 2 * COLUMN_GAP + 2 * PADDING;
  const columnX = {
    blockers: PADDING,
    issue: PADDING + NODE_WIDTH + COLUMN_GAP,
    blocked: PADDING + 2 * (NODE_WIDTH + COLUMN_GAP),
  };

  const column = (nodes: Unplaced[]): GraphNode[] => {
    const span = nodes.length * NODE_HEIGHT + (nodes.length - 1) * ROW_GAP;
    const top = (height - span) / 2;
    return nodes.map(
      (node, index) =>
        ({
          ...node,
          x: columnX[node.side],
          y: top + index * (NODE_HEIGHT + ROW_GAP),
        }) as GraphNode,
    );
  };

  const center: GraphNode = {
    kind: "issue",
    key: "issue",
    side: "issue",
    ref: {
      owner: summary.repo.owner,
      repo: summary.repo.name,
      number: summary.number,
    },
    title: summary.title,
    closed: false,
    url: summary.url,
    synced: false,
    x: columnX.issue,
    y: (height - NODE_HEIGHT) / 2,
  };
  const left = column(blockers);
  const right = column(blocked);

  const middle = center.y + NODE_HEIGHT / 2;
  const edges: GraphEdge[] = [
    ...left.map((node) => ({
      key: `${node.key}->issue`,
      from: { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 },
      to: { x: center.x, y: middle },
      summary: node.kind !== "issue",
    })),
    ...right.map((node) => ({
      key: `issue->${node.key}`,
      from: { x: center.x + NODE_WIDTH, y: middle },
      to: { x: node.x, y: node.y + NODE_HEIGHT / 2 },
      summary: node.kind !== "issue",
    })),
  ];

  return { width, height, nodes: [...left, center, ...right], edges };
}
