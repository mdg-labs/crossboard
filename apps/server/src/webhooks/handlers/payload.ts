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

/** What recording an installation needs: the account it belongs to (SPEC FR-3). */
export const installationCreatedPayload = z.looseObject({
  installation: z.looseObject({
    id: z.number().int(),
    account: z.looseObject({ id: z.number().int(), login: z.string().min(1) }),
    target_type: z.string(),
    suspended_at: z.string().nullish(),
  }),
});

export const repositoriesRemovedPayload = z.looseObject({
  repositories_removed: z.array(node),
});

export const repositoryPayload = z.looseObject({
  repository: z.looseObject({
    node_id: z.string().min(1),
    name: z.string().min(1),
    owner: z.looseObject({ login: z.string().min(1) }),
  }),
});

/** A `github_app_authorization` delivery names its user by `sender`; it has no installation. */
export const authorizationPayload = z.looseObject({
  sender: z.looseObject({ id: z.number().int() }),
});
