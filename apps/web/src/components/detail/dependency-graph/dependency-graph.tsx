import { useId } from "react";
import {
  type GraphNode,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  truncateTitle,
} from "@/components/detail/dependency-graph/layout";
import { ExternalLink, IssueLink } from "@/components/detail/issue-link";
import type { IssueRef, IssueSummary } from "@/lib/issue-detail";
import { cn } from "@/lib/utils";

const TEXT_X = 10;
const LINK_CLASS = "group outline-none";

function NodeBox({
  node,
  active,
}: {
  node: GraphNode;
  active: boolean;
}): React.ReactElement {
  const placeholder = node.kind !== "issue";
  const closed = node.kind === "issue" && node.closed;
  return (
    <g
      className={closed ? "opacity-70" : undefined}
      transform={`translate(${String(node.x)} ${String(node.y)})`}
    >
      <rect
        className={cn(
          "stroke-border group-hover:fill-accent group-focus-visible:stroke-ring",
          active ? "fill-muted stroke-foreground/40" : "fill-card",
          placeholder && "[stroke-dasharray:4_3]",
        )}
        height={NODE_HEIGHT}
        rx={8}
        width={NODE_WIDTH}
      />
      {node.kind === "issue" ? (
        <>
          <text className="fill-muted-foreground text-[10px]" x={TEXT_X} y={17}>
            {node.ref.repo}#{node.ref.number}
          </text>
          <text
            className={cn(
              "text-[11px]",
              closed ? "fill-muted-foreground" : "fill-foreground",
            )}
            style={closed ? { textDecoration: "line-through" } : undefined}
            x={TEXT_X}
            y={33}
          >
            {truncateTitle(node.title)}
          </text>
        </>
      ) : (
        <text
          className="fill-muted-foreground text-[11px]"
          dominantBaseline="central"
          x={TEXT_X}
          y={NODE_HEIGHT / 2}
        >
          {node.label}
        </text>
      )}
    </g>
  );
}

const nodeLabel = (node: Extract<GraphNode, { kind: "issue" }>): string =>
  `${node.ref.owner}/${node.ref.repo}#${String(node.ref.number)} ${node.title}${
    node.closed ? " (closed)" : ""
  }`;

/**
 * The one-hop dependency graph (SPEC FR-27, D-6): hand-written SVG with the
 * blockers on the left, the issue in the middle and the issues it blocks on
 * the right. It draws nothing for an issue without dependencies.
 */
export function DependencyGraph({
  summary,
  onOpenIssue,
}: {
  summary: IssueSummary;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement | null {
  const markerId = useId();
  const layout = layoutGraph(summary);
  if (layout.edges.length === 0) {
    return null;
  }

  return (
    <svg
      aria-label="Dependency graph"
      className="h-auto w-full min-w-[620px]"
      role="group"
      viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
    >
      <defs>
        <marker
          id={markerId}
          markerHeight={7}
          markerWidth={7}
          orient="auto"
          refX={6}
          refY={3.5}
        >
          <path className="fill-muted-foreground" d="M0 0 7 3.5 0 7z" />
        </marker>
      </defs>
      {layout.edges.map((edge) => (
        <line
          className="stroke-muted-foreground"
          data-edge={edge.key}
          key={edge.key}
          markerEnd={`url(#${markerId})`}
          strokeDasharray={edge.summary ? "4 3" : undefined}
          x1={edge.from.x}
          x2={edge.to.x}
          y1={edge.from.y}
          y2={edge.to.y}
        />
      ))}
      {layout.nodes.map((node) => {
        const box = <NodeBox active={node.side === "issue"} node={node} />;
        if (node.kind !== "issue") {
          return (
            <g data-node={node.kind} data-side={node.side} key={node.key}>
              {box}
            </g>
          );
        }
        const link =
          node.side === "issue" ? (
            <ExternalLink
              className={LINK_CLASS}
              href={node.url}
              label={nodeLabel(node)}
            >
              {box}
            </ExternalLink>
          ) : (
            <IssueLink
              className={LINK_CLASS}
              issue={node.ref}
              label={nodeLabel(node)}
              onOpenIssue={onOpenIssue}
              synced={node.synced}
              url={node.url}
            >
              {box}
            </IssueLink>
          );
        return (
          <g data-node="issue" data-side={node.side} key={node.key}>
            <title>{nodeLabel(node)}</title>
            {link}
          </g>
        );
      })}
    </svg>
  );
}
