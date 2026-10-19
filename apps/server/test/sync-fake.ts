import { http, HttpResponse } from "msw";
import { FAKE_API_URL } from "./github-fake.js";

export interface FakeLabel {
  id: string;
  name: string;
  color: string;
  description?: string | null;
}

/** An issue another issue names: its parent, a blocker or something it blocks. */
export interface FakeRef {
  id: string;
  repo: string;
  number: number;
  title?: string;
  state?: "OPEN" | "CLOSED";
}

export interface FakeIssue {
  id: string;
  /** `owner/name` of the repository the issue is in. */
  repo: string;
  number: number;
  title?: string;
  /** Defaults to open; a closed issue is not returned by the open-issues pages. */
  state?: "OPEN" | "CLOSED";
  labels?: FakeLabel[];
  assignees?: { login: string; avatarUrl: string }[];
  type?: { name: string; color: string };
  milestone?: { title: string; url: string };
  parent?: FakeRef;
  /** The relations the installation can read. */
  blockedBy?: FakeRef[];
  blocking?: FakeRef[];
  sub?: { total: number; completed: number };
  /** What GitHub counts, which includes relations the installation cannot read. */
  totalBlockedBy?: number;
  totalBlocking?: number;
}

export interface FakeRepo {
  /** `owner/name` */
  name: string;
  id: string;
  /** The installation that can read the repo; defaults to 1. */
  installationId?: number;
  archived?: boolean;
  issuesEnabled?: boolean;
  /** Every issue of the repo, in the order GitHub returns them. */
  issues: FakeIssue[];
}

export const PAGE = 100;

export const COST = 4;

export const fakeRef = (ref: FakeRef) => ({
  id: ref.id,
  number: ref.number,
  title: ref.title ?? `Issue ${String(ref.number)}`,
  state: ref.state ?? "OPEN",
  url: `https://github.test/${ref.repo}/issues/${String(ref.number)}`,
  repository: { nameWithOwner: ref.repo },
});

/** The page of `items` that starts after the cursor, in a connection of `size` per page. */
export function fakePage<T>(
  items: readonly T[],
  size: number,
  after: string | null,
) {
  const start = after === null ? 0 : Number(after);
  const nodes = items.slice(start, start + size);
  const end = start + nodes.length;
  return {
    pageInfo: { hasNextPage: end < items.length, endCursor: String(end) },
    nodes,
  };
}

const fakeLabel = (label: FakeLabel) => ({
  ...label,
  description: label.description ?? null,
});

export const isOpen = (issue: FakeIssue) => (issue.state ?? "OPEN") === "OPEN";

export const fakeNode = (issue: FakeIssue, withState = false, repoId = "") => {
  const labels = issue.labels ?? [];
  const assignees = issue.assignees ?? [];
  const blockedBy = issue.blockedBy ?? [];
  const blocking = issue.blocking ?? [];
  return {
    ...(withState
      ? { state: issue.state ?? "OPEN", repository: { id: repoId } }
      : {}),
    id: issue.id,
    databaseId: 1000 + issue.number,
    number: issue.number,
    title: issue.title ?? `Issue ${String(issue.number)}`,
    url: `https://github.test/${issue.repo}/issues/${String(issue.number)}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    author: { login: "octocat" },
    issueType: issue.type ?? null,
    milestone: issue.milestone ?? null,
    labels: {
      totalCount: labels.length,
      ...fakePage(labels.map(fakeLabel), 20, null),
    },
    assignees: {
      totalCount: assignees.length,
      ...fakePage(assignees, 10, null),
    },
    parent: issue.parent === undefined ? null : fakeRef(issue.parent),
    subIssuesSummary: issue.sub ?? { total: 0, completed: 0 },
    issueDependenciesSummary: {
      totalBlockedBy: issue.totalBlockedBy ?? blockedBy.length,
      totalBlocking: issue.totalBlocking ?? blocking.length,
    },
    blockedBy: {
      totalCount: blockedBy.length,
      ...fakePage(blockedBy.map(fakeRef), 20, null),
    },
    blocking: {
      totalCount: blocking.length,
      ...fakePage(blocking.map(fakeRef), 20, null),
    },
  };
};

/** What the fake received for one GraphQL request. */
export interface FakeRequest {
  name: string;
  variables: Record<string, unknown>;
  installation: number;
}

export const installationOf = (request: Request): number =>
  Number(
    (request.headers.get("authorization") ?? "").replace(
      "Bearer ghs_fake_for_",
      "",
    ),
  );

/**
 * A GitHub whose GraphQL endpoint answers the sync's queries from `repos`,
 * and hands out an installation token per installation id.
 */
export function createFakeSyncGithub() {
  const world = {
    repos: [] as FakeRepo[],
    /** Issues a lookup by id finds that the repo's pages leave out. */
    hidden: [] as FakeIssue[],
    requests: [] as FakeRequest[],
    /** Fails every GraphQL request for which it returns a status. */
    failWith: undefined as
      ((request: FakeRequest) => number | undefined) | undefined,
    /** Holds each issue lookup's answer, read when it arrived, until this settles. */
    holdIssueLookup: undefined as
      ((request: FakeRequest) => Promise<void>) | undefined,
  };

  const tokens = http.post(
    `${FAKE_API_URL}/app/installations/:installationId/access_tokens`,
    ({ params }) =>
      HttpResponse.json(
        {
          token: `ghs_fake_for_${String(params.installationId)}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { status: 201 },
      ),
  );

  const graphql = http.post(`${FAKE_API_URL}/graphql`, async ({ request }) => {
    const body = (await request.json()) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const name = /query (\w+)/.exec(body.query)?.[1] ?? "";
    const seen: FakeRequest = {
      name,
      variables: body.variables,
      installation: installationOf(request),
    };
    world.requests.push(seen);
    const status = world.failWith?.(seen);
    if (status !== undefined) {
      return HttpResponse.json({ message: "boom" }, { status });
    }
    const rateLimit = {
      cost: COST,
      remaining: 4000,
      resetAt: "2026-01-01T00:00:00Z",
    };
    if (name === "RepositoryStates") {
      const ids = body.variables.ids as string[];
      return HttpResponse.json({
        data: {
          rateLimit,
          nodes: ids.map((id) => {
            const repo = world.repos.find((entry) => entry.id === id);
            return repo === undefined
              ? null
              : {
                  id,
                  isArchived: repo.archived ?? false,
                  hasIssuesEnabled: repo.issuesEnabled ?? true,
                  issues: { totalCount: repo.issues.filter(isOpen).length },
                };
          }),
        },
      });
    }
    if (name === "OpenIssuesPage") {
      const {
        owner,
        name: repoName,
        after,
      } = body.variables as {
        owner: string;
        name: string;
        after: string | null;
      };
      const repo = world.repos.find(
        (entry) => entry.name === `${owner}/${repoName}`,
      );
      if (repo === undefined) {
        return HttpResponse.json({ data: { rateLimit, repository: null } });
      }
      const open = repo.issues.filter(isOpen);
      return HttpResponse.json({
        data: {
          rateLimit,
          repository: {
            issues: {
              totalCount: open.length,
              ...fakePage(
                open.map((entry) => fakeNode(entry)),
                PAGE,
                after,
              ),
            },
          },
        },
      });
    }
    if (name === "IssuesByIds") {
      const ids = body.variables.ids as string[];
      const missing: number[] = [];
      const nodes = ids.map((id, index) => {
        const found = world.repos
          .filter((entry) => (entry.installationId ?? 1) === seen.installation)
          .flatMap((entry) => [
            ...entry.issues.map((issue) => ({ issue, repo: entry })),
            ...world.hidden
              .filter((issue) => issue.repo === entry.name)
              .map((issue) => ({ issue, repo: entry })),
          ])
          .find((entry) => entry.issue.id === id);
        if (found === undefined) missing.push(index);
        return found === undefined
          ? null
          : fakeNode(found.issue, true, found.repo.id);
      });
      await world.holdIssueLookup?.(seen);
      // GitHub answers with the node `null` and a NOT_FOUND entry per missing id.
      return HttpResponse.json({
        data: { rateLimit, nodes },
        ...(missing.length === 0
          ? {}
          : {
              errors: missing.map((index) => ({
                type: "NOT_FOUND",
                path: ["nodes", index],
                message: `Could not resolve to a node with the global id of '${ids[index] ?? ""}'`,
              })),
            }),
      });
    }
    if (name === "IssueConnectionsPage") {
      const issue = world.repos
        .flatMap((entry) => entry.issues)
        .find((entry) => entry.id === body.variables.id);
      if (issue === undefined) {
        return HttpResponse.json({ data: { rateLimit, node: null } });
      }
      const after = (key: string) =>
        body.variables[`${key}After`] as string | null;
      const node: Record<string, unknown> = {};
      if (body.variables.labels === true) {
        node.labels = fakePage(
          (issue.labels ?? []).map(fakeLabel),
          20,
          after("labels"),
        );
      }
      if (body.variables.assignees === true) {
        node.assignees = fakePage(
          issue.assignees ?? [],
          10,
          after("assignees"),
        );
      }
      if (body.variables.blockedBy === true) {
        node.blockedBy = fakePage(
          (issue.blockedBy ?? []).map(fakeRef),
          20,
          after("blockedBy"),
        );
      }
      if (body.variables.blocking === true) {
        node.blocking = fakePage(
          (issue.blocking ?? []).map(fakeRef),
          20,
          after("blocking"),
        );
      }
      return HttpResponse.json({ data: { rateLimit, node } });
    }
    return HttpResponse.json(
      { errors: [{ message: `the fake has no answer for ${name}` }] },
      { status: 200 },
    );
  });

  return {
    world,
    /** The token endpoint, which names each installation's token for it, and the GraphQL endpoint. */
    handlers: [tokens, graphql],
    /** The GraphQL endpoint alone, for a test whose other handlers issue the tokens. */
    graphql,
    reset: () => {
      world.repos = [];
      world.hidden = [];
      world.requests = [];
      world.failWith = undefined;
      world.holdIssueLookup = undefined;
    },
    requestsFor: (name: string) =>
      world.requests.filter((entry) => entry.name === name),
  };
}
