import { http, HttpResponse } from "msw";
import { FAKE_API_URL } from "./github-fake.js";

export interface FakeLabel {
  id: string;
  name: string;
  color: string;
  description?: string | null;
}

export interface FakeIssue {
  id: string;
  /** `owner/name` of the repository the issue is in. */
  repo: string;
  number: number;
  title?: string;
  labels?: FakeLabel[];
  assignees?: { login: string; avatarUrl: string }[];
  type?: { name: string; color: string };
  milestone?: { title: string; url: string };
  parentId?: string;
  sub?: { total: number; completed: number };
  totalBlockedBy?: number;
  totalBlocking?: number;
}

export interface FakeRepo {
  /** `owner/name` */
  name: string;
  id: string;
  archived?: boolean;
  issuesEnabled?: boolean;
  /** The open issues, in the order GitHub returns them. */
  issues: FakeIssue[];
}

export const PAGE = 100;

export const COST = 4;

export const fakeNode = (issue: FakeIssue) => {
  const labels = issue.labels ?? [];
  const assignees = issue.assignees ?? [];
  return {
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
      nodes: labels.map((label) => ({
        ...label,
        description: label.description ?? null,
      })),
    },
    assignees: { totalCount: assignees.length, nodes: assignees },
    parent: issue.parentId === undefined ? null : { id: issue.parentId },
    subIssuesSummary: issue.sub ?? { total: 0, completed: 0 },
    issueDependenciesSummary: {
      totalBlockedBy: issue.totalBlockedBy ?? 0,
      totalBlocking: issue.totalBlocking ?? 0,
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
    requests: [] as FakeRequest[],
    /** Fails every GraphQL request for which it returns a status. */
    failWith: undefined as
      ((request: FakeRequest) => number | undefined) | undefined,
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
                  issues: { totalCount: repo.issues.length },
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
      const start = after === null ? 0 : Number(after);
      const slice = repo.issues.slice(start, start + PAGE);
      const end = start + slice.length;
      return HttpResponse.json({
        data: {
          rateLimit,
          repository: {
            issues: {
              totalCount: repo.issues.length,
              pageInfo: {
                hasNextPage: end < repo.issues.length,
                endCursor: String(end),
              },
              nodes: slice.map(fakeNode),
            },
          },
        },
      });
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
      world.requests = [];
      world.failWith = undefined;
    },
    requestsFor: (name: string) =>
      world.requests.filter((entry) => entry.name === name),
  };
}
