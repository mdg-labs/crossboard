import { z } from "zod";
import type { GithubQuery } from "../github/query.js";
import { queries } from "../github/queries/index.js";
import {
  assigneeSchema,
  labelSchema,
  pageInfoSchema,
  refSchema,
  type IssueNode,
} from "./issue-data.js";

/** Sends one GraphQL query and resolves to its `data`. */
export type Send = (
  query: GithubQuery,
  variables: Record<string, unknown>,
) => Promise<unknown>;

const page = <T extends z.ZodType>(node: T) =>
  z.object({ pageInfo: pageInfoSchema, nodes: z.array(node.nullable()) });

const followUpSchema = z.object({
  node: z
    .object({
      labels: page(labelSchema).optional(),
      assignees: page(assigneeSchema).optional(),
      blockedBy: page(refSchema).optional(),
      blocking: page(refSchema).optional(),
    })
    .nullable(),
});

const KEYS = ["labels", "assignees", "blockedBy", "blocking"] as const;

/**
 * Pages every label, assignee, `blockedBy` and `blocking` connection that
 * runs past its first page, by follow-up queries for the affected issues
 * (SPEC §5.3), and appends the nodes to the issue's own connection.
 */
export async function completeConnections(
  send: Send,
  issueNodes: readonly IssueNode[],
): Promise<void> {
  for (const issue of issueNodes) {
    for (;;) {
      const open = KEYS.filter((key) => issue[key].pageInfo.hasNextPage);
      if (open.length === 0) break;
      const variables: Record<string, unknown> = { id: issue.id };
      for (const key of KEYS) {
        const pending = open.includes(key);
        variables[key] = pending;
        variables[`${key}After`] = pending
          ? issue[key].pageInfo.endCursor
          : null;
      }
      const { node } = followUpSchema.parse(
        await send(queries.issueConnectionsPage, variables),
      );
      if (node === null) throw new Error("an issue is no longer readable");
      for (const key of open) {
        const next = node[key];
        if (next === undefined) {
          throw new Error("GitHub left out a connection that was asked for");
        }
        if (next.pageInfo.hasNextPage && next.pageInfo.endCursor === null) {
          throw new Error("GitHub returned no cursor for the next page");
        }
        // The connections hold different node types; each is appended to its own.
        (issue[key].nodes as unknown[]).push(...next.nodes);
        issue[key].pageInfo = next.pageInfo;
      }
    }
  }
}
