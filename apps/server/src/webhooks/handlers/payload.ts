import { z } from "zod";

/**
 * Only identifiers are read from a payload: which issue, repo or label an
 * event is about. Whatever state it carries (SPEC §5.5, D-11) is fetched
 * instead.
 */
const node = z.looseObject({ node_id: z.string().min(1) });

export const issuePayload = z.looseObject({ issue: node });

export const subIssuesPayload = z.looseObject({
  parent_issue: node.optional(),
  sub_issue: node.optional(),
});

export const dependenciesPayload = z.looseObject({
  blocked_issue: node.optional(),
  blocking_issue: node.optional(),
});

export const labelPayload = z.looseObject({
  label: z.looseObject({
    node_id: z.string().min(1),
    name: z.string(),
    color: z.string(),
    description: z.string().nullish(),
  }),
  repository: node,
});
