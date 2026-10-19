import { useEffect, useId, useState } from "react";
import {
  DEFAULT_WIDTH,
  type GraphLayout,
  type GraphNode,
  layoutGraph,
  NODE_HEIGHT,
  truncateTitle,
} from "@/components/detail/dependency-graph/layout";
import { ExternalLink, IssueLink } from "@/components/detail/issue-link";
import type { IssueRef, IssueSummary } from "@/lib/issue-detail";
import { cn } from "@/lib/utils";

const TEXT_X = 10;
const LINK_CLASS = "group outline-none";

/** The width of `element`, kept current while it resizes; `null` until measured. */
function useWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (element === null) {
      return;
    }
    const measure = (): void => {
      if (element.clientWidth > 0) {
        setWidth(element.clientWidth);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return width;
}

function NodeBox({
  node,
  width,
  active,
}: {
  node: GraphNode;
  width: number;
  active: boolean;
}): React.ReactElement {
  const placeholder = node.kind !== "issue";
  const closed = node.kind === "issue" && node.closed;
  const blocking = node.kind === "issue" && node.blocking;
  return (
    <g
      className={closed ? "opacity-70" : undefined}
      data-blocking={blocking ? "true" : undefined}
      transform={`translate(${String(node.x)} ${String(node.y)})`}
    >
      <rect
        className={cn(
          blocking
            ? "fill-destructive/8 stroke-destructive/50 group-hover:fill-destructive/16"
            : "stroke-border group-hover:fill-accent",
          !blocking &&
            (active ? "fill-muted stroke-foreground/40" : "fill-card"),
          "group-focus-visible:stroke-ring",
          placeholder && "[stroke-dasharray:4_3]",
        )}
        height={NODE_HEIGHT}
        rx={8}
        width={width}
      />
      <svg height={NODE_HEIGHT} width={width - TEXT_X - 6} x={TEXT_X} y={0}>
        {node.kind === "issue" ? (
          <>
            <text className="fill-muted-foreground text-[11px]" y={19}>
              {node.ref.repo}#{node.ref.number}
            </text>
            <text
              className={cn(
                "text-xs",
                closed ? "fill-muted-foreground" : "fill-foreground",
              )}
              style={closed ? { textDecoration: "line-through" } : undefined}
              y={37}
            >
              {truncateTitle(node.title)}
            </text>
          </>
        ) : (
          <text
            className="fill-muted-foreground text-xs"
            dominantBaseline="central"
            y={NODE_HEIGHT / 2}
          >
            {node.label}
          </text>
        )}
      </svg>
    </g>
  );
}

const nodeLabel = (node: Extract<GraphNode, { kind: "issue" }>): string =>
  `${node.ref.owner}/${node.ref.repo}#${String(node.ref.number)} ${node.title}${
    node.closed ? " (closed)" : node.blocking ? " (open blocker)" : ""
  }`;

function Graph({
  layout,
  onOpenIssue,
}: {
  layout: GraphLayout;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement {
  const markerId = useId();
  const [highlighted, setHighlighted] = useState<string | null>(null);

  return (
    <svg
      aria-label="Dependency graph"
      className="mx-auto block max-w-full"
      data-mode={layout.mode}
      height={layout.height}
      role="group"
      viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
      width={layout.width}
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
        <marker
          id={`${markerId}-highlighted`}
          markerHeight={7}
          markerWidth={7}
          orient="auto"
          refX={6}
          refY={3.5}
        >
          <path className="fill-foreground" d="M0 0 7 3.5 0 7z" />
        </marker>
      </defs>
      {layout.headings.map((heading) => (
        <text
          className="fill-muted-foreground font-medium text-[11px]"
          data-heading={heading.key}
          key={heading.key}
          x={heading.x}
          y={heading.y}
        >
          {heading.text}
        </text>
      ))}
      {layout.edges.map((edge) => {
        const on = edge.nodeKey === highlighted;
        return (
          <path
            className={cn(
              "fill-none",
              on ? "stroke-foreground stroke-2" : "stroke-muted-foreground/70",
            )}
            d={edge.path}
            data-edge={edge.key}
            data-highlighted={on ? "true" : undefined}
            key={edge.key}
            markerEnd={`url(#${markerId}${on ? "-highlighted" : ""})`}
            strokeDasharray={edge.summary ? "4 3" : undefined}
          />
        );
      })}
      {layout.nodes.map((node) => {
        const box = (
          <NodeBox
            active={node.side === "issue"}
            node={node}
            width={layout.nodeWidth}
          />
        );
        if (node.kind !== "issue") {
          return (
            <g
              data-node={node.kind}
              data-side={node.side}
              key={node.key}
              onPointerEnter={() => {
                setHighlighted(node.key);
              }}
              onPointerLeave={() => {
                setHighlighted(null);
              }}
            >
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
          <g
            data-node="issue"
            data-side={node.side}
            key={node.key}
            onBlur={() => {
              setHighlighted(null);
            }}
            onFocus={() => {
              setHighlighted(node.key);
            }}
            onPointerEnter={() => {
              setHighlighted(node.key);
            }}
            onPointerLeave={() => {
              setHighlighted(null);
            }}
          >
            <title>{nodeLabel(node)}</title>
            {link}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The one-hop dependency graph (SPEC FR-27, D-6): hand-written SVG with the
 * blockers on the left, the issue in the middle and the issues it blocks on
 * the right, sized to the width it is given and stacked vertically below the
 * narrowest column layout. It draws nothing for an issue without
 * dependencies.
 */
export function DependencyGraph({
  summary,
  onOpenIssue,
}: {
  summary: IssueSummary;
  onOpenIssue: (issue: IssueRef) => void;
}): React.ReactElement | null {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const width = useWidth(container);
  const layout = layoutGraph(summary, width ?? DEFAULT_WIDTH);
  if (layout.edges.length === 0) {
    return null;
  }

  return (
    <div className="w-full min-w-0" ref={setContainer}>
      <Graph layout={layout} onOpenIssue={onOpenIssue} />
    </div>
  );
}
