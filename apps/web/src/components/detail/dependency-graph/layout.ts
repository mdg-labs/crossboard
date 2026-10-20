import type { IssueRef, IssueRelation, IssueSummary } from "@/lib/issue-detail";

/** At most this many relations are drawn on each side (SPEC FR-27). */
export const MAX_NODES_PER_SIDE = 15;
/** Titles are cut to this many characters, ellipsis included. */
export const MAX_TITLE_LENGTH = 40;

/** Node widths are derived from the available width, between these bounds. */
export const MIN_NODE_WIDTH = 140;
export const MAX_NODE_WIDTH = 260;
export const NODE_HEIGHT = 48;
/** The width assumed before the container has been measured. */
export const DEFAULT_WIDTH = 640;
const ROW_GAP = 8;
const COLUMN_GAP = 44;
const PADDING = 4;
const HEADING_HEIGHT = 22;
const GROUP_GAP = 12;
/** The strip left of stacked nodes where their edges run. */
const STACK_GUTTER = 20;

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
      /** An open blocker of the issue (SPEC FR-25), tinted like the "blocked" badge. */
      blocking: boolean;
      url: string;
      /** Whether the issue has a detail view in the app. */
      synced: boolean;
    }
  | { kind: "more" | "hidden"; label: string };

type Unplaced = Identified & NodeContent;

export type GraphNode = Unplaced & { x: number; y: number };

export interface GraphEdge {
  key: string;
  /** The node whose hover or focus highlights this edge. */
  nodeKey: string;
  /** A cubic Bézier path ending at the arrow. */
  path: string;
  /** An edge to a "+N" node stands for several issues. */
  summary: boolean;
}

export interface GraphHeading {
  key: string;
  text: string;
  x: number;
  y: number;
}

/** Three columns when they fit, else the groups stacked vertically. */
export type GraphMode = "columns" | "stacked";

export interface GraphLayout {
  mode: GraphMode;
  width: number;
  height: number;
  nodeWidth: number;
  headings: GraphHeading[];
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
    blocking: side === "blockers" && entry.state === "OPEN",
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

const bezier = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  controlX: number,
  otherControlX: number,
): string =>
  `M${String(fromX)} ${String(fromY)}C${String(controlX)} ${String(fromY)} ${String(otherControlX)} ${String(toY)} ${String(toX)} ${String(toY)}`;

/** An edge between two columns leaves and enters horizontally. */
const columnCurve = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string =>
  bezier(fromX, fromY, toX, toY, (fromX + toX) / 2, (fromX + toX) / 2);

/** An edge between stacked nodes runs through the gutter on their left. */
const gutterCurve = (
  edgeX: number,
  fromY: number,
  toY: number,
  gutterX: number,
): string => bezier(edgeX, fromY, edgeX, toY, gutterX, gutterX);

const relationCount = (relations: Relations): number =>
  relations.items.length + relations.notAccessible;

/**
 * The graph for `availableWidth` pixels (SPEC FR-27): the blockers, the issue
 * and the issues it blocks in three columns when they fit, else stacked
 * vertically. The layout is never wider than `availableWidth`.
 */
export function layoutGraph(
  summary: IssueSummary,
  availableWidth: number = DEFAULT_WIDTH,
): GraphLayout {
  const blockers = sideNodes("blockers", summary.blockedBy);
  const blocked = sideNodes("blocked", summary.blocking);
  const center: Unplaced = {
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
    blocking: false,
    url: summary.url,
    synced: false,
  };
  const headingText = {
    blockers: `Blocked by ${String(relationCount(summary.blockedBy))}`,
    issue: "This issue",
    blocked: `Blocking ${String(relationCount(summary.blocking))}`,
  };

  const columnWidth = Math.min(
    MAX_NODE_WIDTH,
    Math.floor((availableWidth - 2 * COLUMN_GAP - 2 * PADDING) / 3),
  );
  const mode: GraphMode = columnWidth >= MIN_NODE_WIDTH ? "columns" : "stacked";

  if (mode === "columns") {
    const nodeWidth = columnWidth;
    const rows = Math.max(blockers.length, blocked.length, 1);
    const area = rows * NODE_HEIGHT + (rows - 1) * ROW_GAP;
    const top = PADDING + HEADING_HEIGHT;
    const columnX = {
      blockers: PADDING,
      issue: PADDING + nodeWidth + COLUMN_GAP,
      blocked: PADDING + 2 * (nodeWidth + COLUMN_GAP),
    };
    const column = (nodes: Unplaced[]): GraphNode[] => {
      const span = nodes.length * NODE_HEIGHT + (nodes.length - 1) * ROW_GAP;
      const start = top + (area - span) / 2;
      return nodes.map(
        (node, index) =>
          ({
            ...node,
            x: columnX[node.side],
            y: start + index * (NODE_HEIGHT + ROW_GAP),
          }) as GraphNode,
      );
    };
    const left = column(blockers);
    const right = column(blocked);
    const middle = column([center])[0] as GraphNode;
    const middleY = middle.y + NODE_HEIGHT / 2;

    return {
      mode,
      width: 3 * nodeWidth + 2 * COLUMN_GAP + 2 * PADDING,
      height: top + area + PADDING,
      nodeWidth,
      headings: [
        ...(left.length > 0 ? (["blockers"] as const) : []),
        "issue" as const,
        ...(right.length > 0 ? (["blocked"] as const) : []),
      ].map((side) => ({
        key: side,
        text: headingText[side],
        x: columnX[side],
        y: PADDING + 13,
      })),
      nodes: [...left, middle, ...right],
      edges: [
        ...left.map((node) => ({
          key: `${node.key}->issue`,
          nodeKey: node.key,
          path: columnCurve(
            node.x + nodeWidth,
            node.y + NODE_HEIGHT / 2,
            middle.x,
            middleY,
          ),
          summary: node.kind !== "issue",
        })),
        ...right.map((node) => ({
          key: `issue->${node.key}`,
          nodeKey: node.key,
          path: columnCurve(
            middle.x + nodeWidth,
            middleY,
            node.x,
            node.y + NODE_HEIGHT / 2,
          ),
          summary: node.kind !== "issue",
        })),
      ],
    };
  }

  const nodeWidth = Math.max(
    1,
    Math.min(MAX_NODE_WIDTH, availableWidth - 2 * PADDING - STACK_GUTTER),
  );
  const x = PADDING + STACK_GUTTER;
  let y = PADDING;
  const headings: GraphHeading[] = [];
  const group = (side: Side, nodes: Unplaced[]): GraphNode[] => {
    headings.push({ key: side, text: headingText[side], x, y: y + 13 });
    y += HEADING_HEIGHT;
    const placed = nodes.map((node, index) => ({
      ...node,
      x,
      y: y + index * (NODE_HEIGHT + ROW_GAP),
    })) as GraphNode[];
    y += nodes.length * NODE_HEIGHT + (nodes.length - 1) * ROW_GAP + GROUP_GAP;
    return placed;
  };
  const left = blockers.length > 0 ? group("blockers", blockers) : [];
  const middle = group("issue", [center])[0] as GraphNode;
  const right = blocked.length > 0 ? group("blocked", blocked) : [];
  const middleY = middle.y + NODE_HEIGHT / 2;

  return {
    mode,
    width: nodeWidth + STACK_GUTTER + 2 * PADDING,
    height: y - GROUP_GAP + PADDING,
    nodeWidth,
    headings,
    nodes: [...left, middle, ...right],
    edges: [
      ...left.map((node) => ({
        key: `${node.key}->issue`,
        nodeKey: node.key,
        path: gutterCurve(x, node.y + NODE_HEIGHT / 2, middleY, PADDING),
        summary: node.kind !== "issue",
      })),
      ...right.map((node) => ({
        key: `issue->${node.key}`,
        nodeKey: node.key,
        path: gutterCurve(x, middleY, node.y + NODE_HEIGHT / 2, PADDING),
        summary: node.kind !== "issue",
      })),
    ],
  };
}
